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

// What a super admin may send to add or remove a household. Looked up by farm unit, which is how admins name a home.
export function validateAccess(body) {
  const raw = typeof body?.farmUnit === 'string' ? body.farmUnit.trim().toUpperCase() : '';
  const farmUnit = /^F[0-9]{2}$/.test(raw) ? `F-${raw.slice(1)}` : raw;
  if (!/^F-[0-9]{2}$/.test(farmUnit)) return { error: 'Enter the farm unit, for example F-12.' };
  if (!FEATURES[body?.feature]) return { error: 'Choose a feature.' };
  if (typeof body?.enabled !== 'boolean') return { error: 'Say whether to turn it on or off.' };
  return { access: { farmUnit, feature: body.feature, enabled: body.enabled } };
}
