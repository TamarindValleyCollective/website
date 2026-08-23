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

// Sky brightness added by artificial light, in milli-candela per square
// metre -- quoted on the Visit, Host-an-Event, and Geography/Weather pages
// for the stargazing pitch. Sourced from a light-pollution map reading for
// the valley; a negligible figure next to typical urban skies (Bangalore
// runs several hundred times brighter), which is why stars and the Milky
// Way stay visible to the naked eye on a clear night here.
export const NIGHT_SKY_BRIGHTNESS_UCD_M2 = 31.8;

// The "TVC sits inside an elephant corridor" fact, quoted on About,
// Geography/Landscape, and Visit's FAQ -- previously independently worded
// on each page, with the wider-chain membership drifting between them
// (some pages named MM Hills/BR Hills/Sathyamangalam, Visit's FAQ named
// Cauvery North Wildlife Sanctuary instead). One clause here, spliced into
// each sentence, so a future correction is one edit instead of three.
// A noun-phrase fragment (not a full sentence) so each page can embed it
// in its own surrounding grammar. Trekking's and Biodiversity's shorter,
// unelaborated mentions ("the corridor connecting Bannerghatta to the
// Cauvery") are left as-is rather than forced to the full chain -- they're
// not wrong, just brief, and Biodiversity explicitly defers to Landscape
// for the fuller picture.
export const ELEPHANT_CORRIDOR_CLAUSE =
  'a live elephant corridor connecting Bannerghatta National Park to the Cauvery — one link in a wider chain that also ties in MM Hills, BR Hills, Sathyamangalam, and the Nilgiri Biosphere Reserve';

// The registered legal entity operating the Tamarind Valley Collective
// brand and this site - referenced on the Terms, Refund, and Privacy
// pages, and the footer, for payment-gateway (Razorpay) compliance.
export const LEGAL_ENTITY_NAME = 'Syntropic Farm Management Private Limited';
export const LEGAL_ENTITY_CIN = 'U01120KA2022PTC161809';
export const LEGAL_ENTITY_PAN = 'ABICS6243H';
export const LEGAL_ENTITY_ADDRESS =
  'Plot No. 227-228, AMR Brick Field Shelters, Bendiganahalli, Mayasandra, Bangalore, Karnataka 562107, India';
