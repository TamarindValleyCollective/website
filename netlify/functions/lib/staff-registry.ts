// Role/capability registry for the internal admin modules (issue #89). The
// database (staff_module_roles, supabase/migrations/0028_staff_access.sql)
// stores only *who holds which role in which module*; what a role may do
// lives here, in reviewed code, so adding a capability is a diff someone
// approves rather than a value typed into a table.
//
// Shape: module -> capability -> the roles that carry it. `admin` is listed
// explicitly everywhere rather than implied, so a capability that should
// stay out of an admin's hands is a visible omission, not a special case.
// `super_admin` is deliberately absent: it is a global flag on staff_users
// that manages access and has no implicit module access (see staff-access.ts).
//
// First-pass capability lists, taken from what each existing page does today.
// Each module's list gets confirmed against its page/function when that
// module migrates onto requireStaff.
export type Role = 'admin' | 'user' | 'read_only';

const ALL: readonly Role[] = ['read_only', 'user', 'admin'];
const WRITERS: readonly Role[] = ['user', 'admin'];
const ADMIN_ONLY: readonly Role[] = ['admin'];

export const MODULES = {
  'photo-pool': {
    view: ALL,
    review: WRITERS,
  },
  whatsapp: {
    view: ALL,
    reply: WRITERS,
    manage: ADMIN_ONLY, // e.g. blocking a conversation
  },
  'event-payments': {
    view: ALL,
    refund: ADMIN_ONLY, // real money movement through Razorpay
  },
  accommodation: {
    view: ALL,
    // A `user` row may carry scope.allowedTypes to limit which booking types
    // they can edit — the old Sheet's "restricted" role.
    edit: WRITERS,
    admin: ADMIN_ONLY,
  },
} as const satisfies Record<string, Record<string, readonly Role[]>>;

export type ModuleId = keyof typeof MODULES;
export type Capability<M extends ModuleId> = keyof (typeof MODULES)[M] & string;

export function roleHasCapability<M extends ModuleId>(module: M, role: Role, capability: Capability<M>): boolean {
  const roles = MODULES[module][capability] as readonly Role[];
  return roles.includes(role);
}
