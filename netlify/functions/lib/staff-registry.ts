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

export const ROLES: readonly Role[] = ['admin', 'user', 'read_only'];

// What the Access module shows when someone is deciding which role to give:
// a plain-language name for each module and for what each capability allows.
// Kept beside MODULES so a new capability gets a sentence saying what it lets
// a person do. If one is missing, the Access screen falls back to showing the
// capability's own name rather than hiding the module.
export const MODULE_INFO: Record<ModuleId, { label: string; path: string; capabilities: Record<string, string> }> = {
  'photo-pool': {
    label: 'Photo pool',
    path: '/internal/photo-pool/',
    capabilities: {
      view: 'See the photo inbox',
      review: 'Approve, reject and describe photos',
    },
  },
  whatsapp: {
    label: 'WhatsApp inbox',
    path: '/internal/whatsapp/',
    capabilities: {
      view: 'Read conversations',
      reply: 'Send replies',
      manage: 'Block and unblock contacts',
    },
  },
  'event-payments': {
    label: 'Event payments',
    path: '/internal/event-payments/',
    capabilities: {
      view: 'See bookings and totals',
      refund: 'Issue refunds, single or for a whole event',
    },
  },
  accommodation: {
    label: 'Accommodation calendar',
    path: '/internal/accommodation-calendar/',
    capabilities: {
      view: 'See the calendar and guests',
      edit: 'Create, change and cancel bookings (limited to the booking types below if any are chosen)',
      admin: 'Everything in the calendar, with no booking-type limit',
    },
  },
};

// The booking types a `user` in the accommodation module can be limited to
// (the scope that replaced the old Sheet's "restricted" role). Shared with
// accommodation-admin.mts so the two lists can't drift apart.
export const BOOKING_TYPES = ['public-event', 'private-event', 'casual-stay', 'member-stay', 'unit-closure', 'farm-closure'] as const;
export type BookingType = (typeof BOOKING_TYPES)[number];

// For a role in a module: the capabilities it carries, in the registry's order.
export function capabilitiesForRole(module: ModuleId, role: Role): string[] {
  return Object.entries(MODULES[module])
    .filter(([, roles]) => (roles as readonly Role[]).includes(role))
    .map(([capability]) => capability);
}

export function isModuleId(value: unknown): value is ModuleId {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(MODULES, value);
}

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}
