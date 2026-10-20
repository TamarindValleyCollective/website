// Validation for the staff edits on the member register (/internal/members).
// Pure functions: netlify/functions/members-admin.mts calls these, then writes.
//
// Every edit is one JSON object { action, ...fields }. `validateEdit` returns
// either { ok: true, edit } with cleaned values, or { ok: false, error } with a
// message that is safe to show. Nothing here reads the database, so rules that
// need it (an email already used by someone else, a house already taken) are
// enforced by the unique indexes and turned into messages by the function.
//
// Contact details are write-only: for email and phone, `undefined` means "leave
// as is", a string means "replace", and `null` means "remove".
import { normalizeMobileNumber } from './phone.mjs';

// Which capability each action needs (see staff-registry.ts, module `members`).
export const ACTION_CAPABILITY = {
  'person.update': 'edit',
  'person.add': 'manage',
  'membership.update': 'manage',
  'membership.move': 'manage',
  'membership.remove': 'manage',
  'membership.invite': 'manage',
  'household.update': 'manage',
  'plot.create': 'manage',
  'plot.update': 'manage',
  'plot.delete': 'manage',
  'housepatta.create': 'manage',
  'housepatta.update': 'manage',
  'housepatta.delete': 'manage',
  'landdoc.approve': 'manage',
  'landdoc.reject': 'manage',
  // The core team's decision on a member's submitted story (member_stories).
  'story.approve': 'manage',
  'story.reject': 'manage',
};

export const CLUSTERS = ['H1-A', 'H1-B', 'H2'];
export const ROLES = ['owner', 'family', 'non_owner'];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const fail = (error) => ({ ok: false, error });
const ok = (edit) => ({ ok: true, edit });

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function id(body, key) {
  const v = body[key];
  return typeof v === 'string' && UUID.test(v) ? { value: v.toLowerCase() } : { error: `${key} is missing or not valid.` };
}

// Required text, trimmed, 1..max characters.
function requiredText(body, key, label, max) {
  const v = typeof body[key] === 'string' ? body[key].trim().replace(/\s+/g, ' ') : '';
  if (!v) return { error: `${label} is required.` };
  if (v.length > max) return { error: `${label} is too long (at most ${max} characters).` };
  return { value: v };
}

// Optional text: undefined = leave, null or '' = clear, otherwise trimmed.
function optionalText(body, key, label, max) {
  if (!(key in body) || body[key] === undefined) return { skip: true };
  const v = body[key];
  if (v === null || (typeof v === 'string' && v.trim() === '')) return { value: null };
  if (typeof v !== 'string') return { error: `${label} must be text.` };
  const t = v.trim();
  if (t.length > max) return { error: `${label} is too long (at most ${max} characters).` };
  return { value: t };
}

function optionalNumber(body, key, label, max, places) {
  if (!(key in body) || body[key] === undefined) return { skip: true };
  const v = body[key];
  if (v === null || v === '') return { value: null };
  const n = typeof v === 'number' ? v : Number(String(v).replace(/,/g, ''));
  if (!Number.isFinite(n) || n < 0) return { error: `${label} must be a number, zero or more.` };
  if (n > max) return { error: `${label} is larger than expected.` };
  return { value: Math.round(n * 10 ** places) / 10 ** places };
}

// Email: undefined leave, null/'' remove, string replace (lower-cased).
function email(body) {
  if (!('email' in body) || body.email === undefined) return { skip: true };
  if (body.email === null || (typeof body.email === 'string' && body.email.trim() === '')) return { value: null };
  if (typeof body.email !== 'string') return { error: 'Email must be text.' };
  const e = body.email.trim().toLowerCase();
  if (e.length > 200 || !EMAIL.test(e)) return { error: "That doesn't look like an email address." };
  return { value: e };
}

// Phone: stored as E.164. A number that doesn't parse is rejected, not dropped.
function phone(body) {
  if (!('phone' in body) || body.phone === undefined) return { skip: true };
  if (body.phone === null || (typeof body.phone === 'string' && body.phone.trim() === '')) return { value: null };
  if (typeof body.phone !== 'string') return { error: 'Phone must be text.' };
  const n = normalizeMobileNumber(body.phone);
  return n ? { value: n } : { error: "That doesn't look like a valid mobile number." };
}

// Collects `{ key: value }` for fields that were provided, or the first error.
function collect(parts) {
  const values = {};
  for (const [key, r] of parts) {
    if (r.error) return { error: r.error };
    if (!r.skip) values[key] = r.value;
  }
  return { values };
}

const PLOT_FIELDS = (body) => [
  ['pattaNo', optionalText(body, 'pattaNo', 'Patta number', 40)],
  ['referenceNo', optionalText(body, 'referenceNo', 'Reference number', 60)],
  ['surveyNo', optionalText(body, 'surveyNo', 'Survey number', 40)],
  ['settlement', optionalText(body, 'settlement', 'Settlement', 40)],
];

export function validateEdit(body) {
  if (!isObject(body) || typeof body.action !== 'string') return fail('Nothing to do.');
  const { action } = body;
  if (!(action in ACTION_CAPABILITY)) return fail('Unknown action.');

  switch (action) {
    case 'person.update': {
      const personId = id(body, 'personId');
      if (personId.error) return fail(personId.error);
      const name = 'fullName' in body ? requiredText(body, 'fullName', 'Name', 120) : { skip: true };
      const c = collect([['fullName', name], ['email', email(body)], ['phone', phone(body)]]);
      if (c.error) return fail(c.error);
      if (Object.keys(c.values).length === 0) return fail('Nothing to change.');
      return ok({ action, personId: personId.value, ...c.values });
    }

    case 'person.add': {
      const householdId = id(body, 'householdId');
      if (householdId.error) return fail(householdId.error);
      const name = requiredText(body, 'fullName', 'Name', 120);
      if (name.error) return fail(name.error);
      const role = body.role ?? 'owner';
      if (!ROLES.includes(role)) return fail('Role must be owner, family or non_owner.');
      const c = collect([['email', email(body)], ['phone', phone(body)]]);
      if (c.error) return fail(c.error);
      return ok({ action, householdId: householdId.value, fullName: name.value, role, ...c.values });
    }

    case 'membership.update': {
      const householdId = id(body, 'householdId');
      const personId = id(body, 'personId');
      if (householdId.error || personId.error) return fail(householdId.error ?? personId.error);
      if (!ROLES.includes(body.role)) return fail('Role must be owner, family or non_owner.');
      return ok({ action, householdId: householdId.value, personId: personId.value, role: body.role });
    }

    case 'membership.move': {
      const from = id(body, 'fromHouseholdId');
      const to = id(body, 'toHouseholdId');
      const personId = id(body, 'personId');
      const bad = from.error ?? to.error ?? personId.error;
      if (bad) return fail(bad);
      if (from.value === to.value) return fail('Choose a different household to move them to.');
      return ok({ action, fromHouseholdId: from.value, toHouseholdId: to.value, personId: personId.value });
    }

    case 'membership.invite': {
      // Lets a person sign in to the member portal (canLogin true) or stops them (false).
      const householdId = id(body, 'householdId');
      const personId = id(body, 'personId');
      if (householdId.error || personId.error) return fail(householdId.error ?? personId.error);
      if (typeof body.canLogin !== 'boolean') return fail('Choose whether this person can sign in.');
      return ok({ action, householdId: householdId.value, personId: personId.value, canLogin: body.canLogin });
    }

    case 'membership.remove': {
      const householdId = id(body, 'householdId');
      const personId = id(body, 'personId');
      if (householdId.error || personId.error) return fail(householdId.error ?? personId.error);
      return ok({ action, householdId: householdId.value, personId: personId.value });
    }

    case 'household.update': {
      const householdId = id(body, 'householdId');
      if (householdId.error) return fail(householdId.error);
      const parts = [];
      if ('houseNo' in body && body.houseNo !== undefined) {
        const h = body.houseNo === null || body.houseNo === '' ? null : String(body.houseNo).trim().toUpperCase();
        if (h !== null && !/^H-\d{2}$/.test(h)) return fail('A house number looks like H-07.');
        parts.push(['houseNo', { value: h }]);
      }
      if ('cluster' in body && body.cluster !== undefined) {
        const cl = body.cluster === null || body.cluster === '' ? null : body.cluster;
        if (cl !== null && !CLUSTERS.includes(cl)) return fail('Cluster must be H1-A, H1-B or H2.');
        parts.push(['cluster', { value: cl }]);
      }
      parts.push(['unitType', optionalText(body, 'unitType', 'Unit type', 20)]);
      const c = collect(parts);
      if (c.error) return fail(c.error);
      if (Object.keys(c.values).length === 0) return fail('Nothing to change.');
      return ok({ action, householdId: householdId.value, ...c.values });
    }

    case 'plot.create':
    case 'plot.update': {
      const create = action === 'plot.create';
      const key = create ? 'householdId' : 'plotId';
      const target = id(body, key);
      if (target.error) return fail(target.error);
      const parts = [
        ...PLOT_FIELDS(body),
        ['areaHectares', optionalNumber(body, 'areaHectares', 'Hectares', 1000, 4)],
        ['areaAcres', optionalNumber(body, 'areaAcres', 'Acres', 2500, 2)],
      ];
      if (!create && 'householdId' in body && body.householdId !== undefined) {
        const to = id(body, 'householdId');
        if (to.error) return fail(to.error);
        parts.push(['householdId', { value: to.value }]);
      }
      const c = collect(parts);
      if (c.error) return fail(c.error);
      if (Object.keys(c.values).length === 0) return fail(create ? 'Enter at least one detail.' : 'Nothing to change.');
      return ok({ action, [key]: target.value, ...c.values });
    }

    case 'housepatta.create':
    case 'housepatta.update': {
      const create = action === 'housepatta.create';
      const key = create ? 'householdId' : 'housePattaId';
      const target = id(body, key);
      if (target.error) return fail(target.error);
      const parts = [...PLOT_FIELDS(body), ['areaSqFt', optionalNumber(body, 'areaSqFt', 'Square feet', 1000000, 2)]];
      if (!create && 'householdId' in body && body.householdId !== undefined) {
        const to = id(body, 'householdId');
        if (to.error) return fail(to.error);
        parts.push(['householdId', { value: to.value }]);
      }
      const c = collect(parts);
      if (c.error) return fail(c.error);
      if (Object.keys(c.values).length === 0) return fail(create ? 'Enter at least one detail.' : 'Nothing to change.');
      return ok({ action, [key]: target.value, ...c.values });
    }

    // The core team's decision on one record read from an uploaded land document.
    case 'landdoc.approve':
    case 'landdoc.reject': {
      const documentId = id(body, 'documentId');
      if (documentId.error) return fail(documentId.error);
      const itemIndex = body.itemIndex;
      if (!Number.isInteger(itemIndex) || itemIndex < 0 || itemIndex > 11) return fail('itemIndex is missing or not valid.');
      return ok({ action, documentId: documentId.value, itemIndex });
    }

    // `submittedAt` is the timestamp of the submission the reviewer was looking at, so a member
    // who resubmits meanwhile can't have newer wording approved unseen.
    case 'story.approve':
    case 'story.reject': {
      const personId = id(body, 'personId');
      if (personId.error) return fail(personId.error);
      const submittedAt = body.submittedAt;
      if (typeof submittedAt !== 'string' || submittedAt.length > 40 || Number.isNaN(Date.parse(submittedAt))) return fail('submittedAt is missing or not valid.');
      if (action === 'story.approve') return ok({ action, personId: personId.value, submittedAt });
      // A rejection always says what to change: the member sees this note.
      const note = requiredText(body, 'note', 'A note for the member', 500);
      if (note.error) return fail(note.error);
      return ok({ action, personId: personId.value, submittedAt, note: note.value });
    }

    case 'plot.delete': {
      const plotId = id(body, 'plotId');
      return plotId.error ? fail(plotId.error) : ok({ action, plotId: plotId.value });
    }

    case 'housepatta.delete': {
      const housePattaId = id(body, 'housePattaId');
      return housePattaId.error ? fail(housePattaId.error) : ok({ action, housePattaId: housePattaId.value });
    }
  }
  return fail('Unknown action.');
}

// What goes in the audit log for an edit: the action, which records it touched,
// and WHICH fields changed. Never the values of a name, email or phone (the log
// must not hold personal data), but house, cluster, role and land details are
// not personal and are recorded, so a change can be traced.
export function auditDetail(edit) {
  const { action, ...rest } = edit;
  // Land identifiers (patta, reference, survey numbers) tie a person to a plot, so
  // only the field names are logged for those, like names and contact details.
  const SAFE_VALUES = new Set(['role', 'canLogin', 'houseNo', 'cluster', 'unitType', 'areaHectares', 'areaAcres', 'areaSqFt']);
  const ids = {};
  const fields = [];
  const values = {};
  for (const [k, v] of Object.entries(rest)) {
    if (k.endsWith('Id')) ids[k] = v;
    else {
      fields.push(k);
      if (SAFE_VALUES.has(k)) values[k] = v;
    }
  }
  return { ids, fields, ...(Object.keys(values).length ? { values } : {}) };
}
