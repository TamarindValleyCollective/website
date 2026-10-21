// Gives documents uploaded before parcel outlines existed their outline, the first time their
// household's outlines are asked for. Same work as the background reader does for a new upload
// (readLandShape), done lazily so it needs no script and no credentials outside the function.
//
// Only a single-survey PDF (or a stand-alone FMB sketch the member uploaded) can have a sketch. A document checked and found without one is marked
// `shapeChecked` so it is never opened again. A few documents per request keep it quick; the
// rest are done the next time the page is opened.
import { restHeaders } from '../../../scripts/lib/supabase.mjs';
import { shapeNeedsRefresh, withShapeResult } from '../../../scripts/lib/land-shape.mjs';
import { readLandShape } from './land-doc-read';
import { getLandDocument, landShapeKey, putLandDocument } from './land-doc-storage';

const MAX_PER_REQUEST = 3;

type Doc = { id: string; storage_path: string; mime_type: string; extracted: any };

export const needsShapeCheck = (d: Doc): boolean => d.mime_type === 'application/pdf' && shapeNeedsRefresh(d.extracted);

// Updates `extracted` on the passed documents in place, so the caller can go on to load the shapes.
export async function backfillLandShapes(docs: Doc[]): Promise<void> {
  const base = process.env.SUPABASE_URL;
  if (!base) return;
  for (const d of docs.filter(needsShapeCheck).slice(0, MAX_PER_REQUEST)) {
    try {
      const bytes = await getLandDocument(d.storage_path);
      if (!bytes) continue;
      const shape = await readLandShape(bytes, { standalone: d.extracted?.kind === 'fmb_sketch' });
      if (shape) await putLandDocument(landShapeKey(d.storage_path), shape, 'image/png');
      const extracted = withShapeResult(d.extracted, Boolean(shape));
      const res = await fetch(`${base}/rest/v1/member_land_documents?id=eq.${d.id}`, {
        method: 'PATCH',
        headers: restHeaders({ Prefer: 'return=minimal' }),
        body: JSON.stringify({ extracted }),
      });
      if (res.ok) d.extracted = extracted;
    } catch (err) {
      console.error('[land-shape-backfill] could not check a document', err);
    }
  }
}
