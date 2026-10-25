// Which member features are open to which households (table member_feature_access, migration 0071). A feature is on for a
// household when its Netlify flag is "true" (everyone), or when the household has been added to the early-access list.
// Pure, so it is tested directly (member-features.test.mjs); the functions do the reading and writing.

// To add a feature: add it here and to the check constraint on member_feature_access, then call featureOn.
export const FEATURES = {
  rental: { env: 'MEMBER_RENTAL_ENABLED', label: 'My rental' },
};

export const featureIds = () => Object.keys(FEATURES);

// `everyone` is the flag's value; `granted` is whether the household has a row for this feature.
export const featureOn = (everyone, granted) => everyone === 'true' || granted === true;

// What a super admin may send to add or remove a household: chosen from the member list, so it arrives as the household's id.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function validateAccess(body) {
  if (!UUID.test(body?.householdId ?? '')) return { error: 'Choose a member from the list.' };
  if (!FEATURES[body?.feature]) return { error: 'Choose a feature.' };
  if (typeof body?.enabled !== 'boolean') return { error: 'Say whether to turn it on or off.' };
  return { access: { householdId: body.householdId, feature: body.feature, enabled: body.enabled } };
}
