// Flip a locale to true once a native speaker has reviewed every kn/ta
// string added by the initial AI-assisted translation pass (see
// TRANSLATIONS_REVIEW.md) - the draft-translation notice
// (TranslationNotice.astro) disappears site-wide for that locale the moment
// it flips, with no other code changes.
export const TRANSLATION_REVIEWED: Record<'kn' | 'ta', boolean> = {
  kn: false,
  ta: false,
};
