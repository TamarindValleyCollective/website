// Who may use the WhatsApp inbox, and for which conversations. The inbox itself (whatsapp-admin.mts and the
// WhatsAppInbox component) is shared by every screen that talks to people over WhatsApp; this is the one place that
// decides what a caller may see through it:
//
//   scope "all"    the whole inbox: roles of the `whatsapp` module (view / reply / manage), as before.
//   scope "stays"  only the guests on a stay (their number is in the guest directory): roles of the `accommodation`
//                  module, where `view` reads and `edit` replies. Blocking and the STOP list stay with `whatsapp`.
//
// A new screen adds a scope here (and to scripts/lib/whatsapp-scope.mjs): which module's roles apply, and which phone
// numbers it may reach. Every handler must check a conversation against `phones` before touching it.
import { requireStaff, type StaffGrant } from './staff-access';
import { roleHasCapability } from './staff-registry';
import { listGuestMobileNumbers } from '../../../scripts/lib/accommodation-db.mjs';
import { parseScope, phoneSet } from '../../../scripts/lib/whatsapp-scope.mjs';

export type InboxNeed = 'view' | 'reply' | 'manage';

export interface InboxAccess {
  staff: StaffGrant;
  scope: 'all' | 'stays';
  canReply: boolean;
  canManage: boolean;
  /** Conversation numbers (wa_phone) this caller may reach; null means all of them. */
  phones: Set<string> | null;
}

export type InboxAuthResult = { ok: true; access: InboxAccess } | { ok: false; status: number; error: string };

/** True when the conversation's number is one this caller may reach. */
export function canReach(access: InboxAccess, waPhone: string): boolean {
  return access.phones === null || access.phones.has(waPhone);
}

export async function authorizeInbox(req: Request, rawScope: string | null, need: InboxNeed): Promise<InboxAuthResult> {
  const scope = parseScope(rawScope);
  if (!scope) return { ok: false, status: 400, error: 'Unknown scope' };

  if (scope === 'all') {
    const auth = await requireStaff(req, 'whatsapp', need);
    if (!auth.ok) return auth;
    const { role } = auth.staff;
    return {
      ok: true,
      access: { staff: auth.staff, scope, canReply: roleHasCapability('whatsapp', role, 'reply'), canManage: roleHasCapability('whatsapp', role, 'manage'), phones: null },
    };
  }

  // stays: blocking and the opt-out list are whatsapp-module decisions, not something a Stays user may do.
  if (need === 'manage') return { ok: false, status: 403, error: 'Not authorized' };
  const auth = await requireStaff(req, 'accommodation', need === 'reply' ? 'edit' : 'view');
  if (!auth.ok) return auth;
  let phones: Set<string>;
  try {
    phones = phoneSet(await listGuestMobileNumbers()) as Set<string>;
  } catch (err) {
    console.error('[whatsapp-scope] Failed to read the guest directory', err);
    return { ok: false, status: 502, error: 'Failed to reach the message store' };
  }
  return {
    ok: true,
    access: { staff: auth.staff, scope, canReply: roleHasCapability('accommodation', auth.staff.role, 'edit'), canManage: false, phones },
  };
}
