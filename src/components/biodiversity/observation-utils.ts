const API = 'https://api.inaturalist.org/v1/observations';
const PROJECT_SLUG = 'biodiversity-at-tvc';

// iNaturalist's default photo.url points at the "square" size (~75px) —
// fine for a tiny map-pin popup, but visibly blurry stretched across a
// 200-300px grid card. "small" (~240px) is the right size for card
// thumbnails without paying for "medium"'s much larger download on a page
// showing dozens of them at once.
export function thumbUrl(url: string): string {
  return url.replace('square', 'small');
}

export interface Photo {
  id: number;
  url: string;
  attribution: string;
  license_code: string | null;
}

export interface Observation {
  id: number;
  uri: string;
  observed_on: string | null;
  place_guess: string | null;
  geojson: { type: string; coordinates: [number, number] } | null;
  quality_grade: string;
  user: { login: string; name: string | null };
  photos: Photo[];
  taxon: {
    id: number;
    name: string;
    rank: string;
    preferred_common_name: string | null;
    iconic_taxon_name: string | null;
    parent_id: number | null;
    ancestor_ids: number[];
  } | null;
}

// The iconic taxa iNaturalist actually uses, mapped to friendly labels.
// Only groups present in the fetched data are shown as filter chips.
const ICONIC_TAXON_LABELS: Record<string, string> = {
  Aves: 'Birds',
  Insecta: 'Insects',
  Plantae: 'Plants & Flowers',
  Mammalia: 'Mammals',
  Reptilia: 'Reptiles',
  Amphibia: 'Amphibians',
  Mollusca: 'Molluscs',
  Arachnida: 'Arachnids',
  Fungi: 'Fungi',
  Chromista: 'Chromista',
  Protozoa: 'Protozoa',
  Animalia: 'Other Animals',
  Unknown: 'Unidentified',
};

export function labelForIconicTaxon(name: string | null): string {
  if (!name) return 'Unidentified';
  return ICONIC_TAXON_LABELS[name] ?? name;
}

// GeoJSON coordinate order is [lng, lat] — the opposite of Leaflet's L.marker([lat, lng]).
// Centralized here so this isn't a silent bug waiting to happen elsewhere.
export function toLatLng(geojson: Observation['geojson']): [number, number] | null {
  if (!geojson || !Array.isArray(geojson.coordinates) || geojson.coordinates.length !== 2) return null;
  const [lng, lat] = geojson.coordinates;
  return [lat, lng];
}

// The raw API response has many fields we never use (identifications, flags,
// full user profile stats, etc). Mapping down to just what the UI needs keeps
// the in-memory/cached payload small — the full payload for ~104 observations
// serializes to ~5MB, which is enough to hit localStorage's quota in some
// browsers, so trimming it isn't just tidiness, it's what keeps caching working.
function toObservation(raw: any): Observation {
  return {
    id: raw.id,
    uri: raw.uri,
    observed_on: raw.observed_on ?? null,
    place_guess: raw.place_guess ?? null,
    geojson: raw.geojson ?? null,
    quality_grade: raw.quality_grade,
    user: { login: raw.user?.login, name: raw.user?.name ?? null },
    photos: (raw.photos ?? []).map((p: any) => ({
      id: p.id,
      url: p.url,
      attribution: p.attribution,
      license_code: p.license_code ?? null,
    })),
    taxon: raw.taxon
      ? {
          id: raw.taxon.id,
          name: raw.taxon.name,
          rank: raw.taxon.rank,
          preferred_common_name: raw.taxon.preferred_common_name ?? null,
          iconic_taxon_name: raw.taxon.iconic_taxon_name ?? null,
          parent_id: raw.taxon.parent_id ?? null,
          ancestor_ids: raw.taxon.ancestor_ids ?? [],
        }
      : null,
  };
}

export async function fetchAllObservations(): Promise<Observation[]> {
  const cacheKey = `tvc-biodiversity-cache-${PROJECT_SLUG}`;
  // localStorage, not sessionStorage — same 10-minute freshness window below,
  // just shared across tabs and reopens instead of dying with the tab.
  const cached = localStorage.getItem(cacheKey);
  if (cached) {
    try {
      const parsed = JSON.parse(cached);
      if (Date.now() - parsed.fetchedAt < 10 * 60 * 1000) {
        return parsed.observations;
      }
    } catch {
      // fall through to a fresh fetch
    }
  }

  const all: Observation[] = [];
  let page = 1;
  // Defensive pagination loop — the whole project fits in one page today (100+
  // results, per_page max 200), but this holds up if it grows past that.
  while (true) {
    const res = await fetch(
      `${API}?project_id=${PROJECT_SLUG}&per_page=200&page=${page}&order_by=observed_on&order=desc`
    );
    if (!res.ok) throw new Error(`iNaturalist API error ${res.status}`);
    const data = await res.json();
    all.push(...data.results.map(toObservation));
    if (all.length >= data.total_results || data.results.length === 0) break;
    page += 1;
  }

  // Caching is a nice-to-have, not a requirement — a quota error here must
  // never take down the actual page, which is why it's isolated in its own
  // try/catch rather than sharing the caller's error handling.
  try {
    localStorage.setItem(cacheKey, JSON.stringify({ fetchedAt: Date.now(), observations: all }));
  } catch (err) {
    console.warn('Could not cache iNaturalist observations in localStorage:', err);
  }

  return all;
}

export function groupByIconicTaxon(observations: Observation[]): Map<string, Observation[]> {
  const groups = new Map<string, Observation[]>();
  for (const obs of observations) {
    const key = obs.taxon?.iconic_taxon_name ?? 'Unknown';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(obs);
  }
  return groups;
}

// "Related sightings" = same genus (same taxon.parent_id), built once from the
// fetched set — no extra API calls needed for this common path.
export function groupByParentTaxon(observations: Observation[]): Map<number, Observation[]> {
  const groups = new Map<number, Observation[]>();
  for (const obs of observations) {
    const parentId = obs.taxon?.parent_id;
    if (parentId == null) continue;
    if (!groups.has(parentId)) groups.set(parentId, []);
    groups.get(parentId)!.push(obs);
  }
  return groups;
}
