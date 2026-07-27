// Single source of truth for facts repeated as prose across the site
// (meta descriptions, hero copy, footer blurb, etc.) so they can't drift
// out of sync with each other.

// Computed from the TVC property boundary as mapped on OpenStreetMap (see
// src/components/biodiversity/tvc-boundary.ts) -- a geodesic polygon-area
// calculation (spherical excess via Green's theorem, cross-checked against
// an equirectangular-projection + shoelace calculation, both agreeing to
// within a few square meters) gives 397,971 m^2 = 98.34 acres, rounded
// here to the nearest whole acre. The long-used "100 acres" was always a
// round, approximate figure, not a survey number -- this replaces it with
// one derived from the actual mapped boundary. Historical content (past
// event listings, the founding-story membership/acreage target in
// JourneyTimelineStandalone.astro) is deliberately left saying "100
// acres" since those describe the plan or copy as it stood at the time,
// not a present-tense claim about the property's current size.
export const FARM_AREA_ACRES = 98;

// The registered legal entity operating the Tamarind Valley Collective
// brand and this site - referenced on the Terms, Refund, and Privacy
// pages, and the footer, for payment-gateway (Razorpay) compliance.
export const LEGAL_ENTITY_NAME = 'Syntropic Farm Management Private Limited';
export const LEGAL_ENTITY_CIN = 'U01120KA2022PTC161809';
export const LEGAL_ENTITY_PAN = 'ABICS6243H';
export const LEGAL_ENTITY_ADDRESS =
  'Plot No. 227-228, AMR Brick Field Shelters, Bendiganahalli, Mayasandra, Bangalore, Karnataka 562107, India';
