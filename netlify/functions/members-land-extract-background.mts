// Netlify BACKGROUND function (the -background suffix: it answers 202 at once): reads one
// uploaded land document and updates the member register. The upload (members-me.mts) stores
// the file, records it as 'processing', and calls this so the member isn't kept waiting.
// The file is read with a fixed template (lib/land-doc-read.ts), not an AI service.
//
//   POST /.netlify/functions/members-land-extract-background   { documentId }
//
// Nothing in the request is trusted beyond the id: the file, the household and the land type
// all come from the member_land_documents row the upload wrote, and only a row still
// 'processing' is touched, so replaying the call does nothing. The decisions are
// scripts/lib/member-land-docs.mjs.
//
//   register has the survey number and the document agrees  -> mark it verified (fill blanks only)
//   register has no such entry                              -> add it as pending_review
//   anything else (mismatch, photo/scan, a file the template can't read, survey no. held by
//   another household)                                      -> needs_review
//
// Audited like every other member change: the audit row is written BEFORE the register is
// touched, and the document is marked failed if that write fails. The audit detail holds
// counts only, never names or land numbers.
import { restHeaders } from '../../scripts/lib/supabase.mjs';
import { readLandPdf } from './lib/land-doc-read';
import { getLandDocument } from './lib/land-doc-storage';
import { documentStatus, newRecordColumns, normalizeExtraction, reconcile } from '../../scripts/lib/member-land-docs.mjs';

const TABLES = { farm: 'member_plots', house: 'member_house_pattas' } as const;

const supabaseUrl = () => {
  const url = process.env.SUPABASE_URL;
  if (!url) throw new Error('Missing SUPABASE_URL');
  return url;
};

async function select(table: string, query: string): Promise<any[]> {
  const res = await fetch(`${supabaseUrl()}/rest/v1/${table}?${query}`, { headers: restHeaders() });
  if (!res.ok) throw new Error(`${table} select failed: ${res.status}`);
  return res.json();
}

async function patch(table: string, filter: string, body: Record<string, unknown>): Promise<void> {
  const res = await fetch(`${supabaseUrl()}/rest/v1/${table}?${filter}`, { method: 'PATCH', headers: restHeaders({ Prefer: 'return=minimal' }), body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`${table} update failed: ${res.status}`);
}

async function fail(documentId: string, error: string): Promise<void> {
  try {
    await patch('member_land_documents', `id=eq.${documentId}&status=eq.processing`, { status: 'failed', error, processed_at: new Date().toISOString() });
  } catch (err) {
    console.error('[land-extract] could not mark the document failed', err);
  }
}

// Written before anything changes. Counts only: never names or land numbers.
async function recordAudit(doc: any, landType: string, outcomes: Record<string, number>): Promise<boolean> {
  const log = await fetch(`${supabaseUrl()}/rest/v1/member_audit_log`, {
    method: 'POST',
    headers: restHeaders({ Prefer: 'return=minimal' }),
    body: JSON.stringify({ actor_person_id: doc.uploaded_by_person_id, action: 'member.land.process', detail: { documentId: doc.id, landType, outcomes } }),
  }).catch(() => null);
  if (!log || !log.ok) console.error('[land-extract] audit log write failed; nothing applied', log?.status);
  return Boolean(log?.ok);
}

export default async (req: Request): Promise<Response> => {
  let documentId = '';
  try {
    documentId = String((await req.json())?.documentId ?? '');
  } catch {
    // fall through
  }
  if (!/^[0-9a-f-]{36}$/.test(documentId)) return new Response('Bad request', { status: 400 });

  try {
    const [doc] = await select('member_land_documents', `id=eq.${documentId}&status=eq.processing&select=id,household_id,uploaded_by_person_id,land_type,storage_path,mime_type&limit=1`);
    if (!doc) return new Response('Nothing to do', { status: 200 });
    const landType: 'farm' | 'house' = doc.land_type;
    const table = TABLES[landType];

    const bytes = await getLandDocument(doc.storage_path).catch((err) => {
      console.error('[land-extract] could not fetch the stored file', err);
      return null;
    });
    if (!bytes) {
      await fail(documentId, "We couldn't open the file you uploaded. Please upload it again.");
      return new Response('ok');
    }

    // Only a PDF can be read by the template. Anything else, or a PDF that matches no template,
    // is handed to the core team with the file attached (no items, status needs_review).
    const raw = doc.mime_type === 'application/pdf' ? await readLandPdf(bytes) : null;
    const checked: { ok: boolean; extraction?: any; error?: string } = normalizeExtraction(raw);
    if (!checked.ok) {
      await recordAudit(doc, landType, { unread: 1 });
      await patch('member_land_documents', `id=eq.${documentId}`, { status: 'needs_review', items: [], processed_at: new Date().toISOString(), error: null });
      return new Response('ok');
    }
    const extraction = checked.extraction;

    // The household's people, its records of this kind, and every OTHER household's survey
    // numbers of this kind (to catch a number already on someone else's record).
    const links = await select('member_household_members', `household_id=eq.${doc.household_id}&select=person_id`);
    const people = links.length ? await select('member_people', `id=in.(${links.map((l: any) => l.person_id).join(',')})&select=full_name`) : [];
    const existing = await select(table, `household_id=eq.${doc.household_id}&select=*`);
    const others = await select(table, `household_id=neq.${doc.household_id}&select=survey_no&limit=5000`);
    const heldElsewhere = new Set<string>();
    for (const row of others) for (const t of String(row.survey_no ?? '').split(/[,;&]/)) heldElsewhere.add(t.trim().toUpperCase().replace(/\s+/g, '').replace(/[\\-]/g, '/'));

    const items: any[] = reconcile({
      extraction,
      landType,
      household: { peopleNames: people.map((p: any) => p.full_name) },
      existing,
      heldElsewhere,
      autoVerify: doc.mime_type === 'application/pdf',
    });
    const status = documentStatus(items);

    // Recorded first, refused if it can't be: no register change goes unlogged.
    const counts: Record<string, number> = {};
    for (const i of items) counts[i.outcome] = (counts[i.outcome] ?? 0) + 1;
    if (!(await recordAudit(doc, landType, counts))) {
      await fail(documentId, "We couldn't record the result, so nothing was changed. Please try again.");
      return new Response('ok');
    }

    const now = new Date().toISOString();
    for (const item of items) {
      if (item.outcome === 'verified') {
        await patch(table, `id=eq.${item.recordId}`, { ...item.fill, verification: 'verified', verified_at: now, verification_source: 'document', source_document_id: documentId });
      } else if (item.outcome === 'pending') {
        const res = await fetch(`${supabaseUrl()}/rest/v1/${table}`, {
          method: 'POST',
          headers: restHeaders({ Prefer: 'return=representation' }),
          body: JSON.stringify(newRecordColumns(item, landType, extraction, doc.household_id, documentId)),
        });
        if (!res.ok) throw new Error(`${table} insert failed: ${res.status}`);
        item.recordId = (await res.json())?.[0]?.id;
      }
    }

    await patch('member_land_documents', `id=eq.${documentId}`, { status, extracted: extraction, items, processed_at: now, error: null });
    return new Response('ok');
  } catch (err) {
    console.error('[land-extract] failed', err);
    if (documentId) await fail(documentId, "Something went wrong while reading your document. Please try again, or ask the core team.");
    return new Response('ok');
  }
};
