-- Deactivating someone on /internal/access now deletes all of their module roles (staff-admin.mts,
-- handleSetActive). People deactivated before that change still hold theirs; this clears them so the
-- two groups look the same. Each removal is written to staff_audit_log first (actor null: no one
-- acted from the screen), with the previous role and scope so a grant can be restored by hand.
--
-- Super admins are skipped, as the screen skips them. Safe to run twice: the second run finds nothing.

insert into staff_audit_log (actor_id, action, module, target_id, detail)
select null, 'staff.role_removed', r.module, r.staff_id,
       jsonb_build_object('previousRole', r.role, 'previousScope', r.scope, 'reason', 'migration 0064: person already deactivated')
from staff_module_roles r
join staff_users u on u.id = r.staff_id
where u.active = false and u.is_super_admin = false;

delete from staff_module_roles r
using staff_users u
where u.id = r.staff_id and u.active = false and u.is_super_admin = false;
