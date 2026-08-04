// Fetch + cache logic for just the homepage's species-count stat tile,
// deliberately self-contained and NOT sharing observation-utils.ts's module
// graph -- BiodiversityExplorer.astro statically imports observation-utils
// alongside Leaflet, and Vite's chunking for a dynamically-imported module
// that shares a file with a statically-imported one can bundle them
// together. HomeStats.astro dynamically imports this file specifically to
// keep its bundle off the critical path (see the comment in its <script>);
// if this pulled in observation-utils.ts, that dynamic import would also
// pull in Leaflet's ~165KB, even though the homepage never touches a map.
// Confirmed by testing: that's exactly what happened before this file was
// split out on its own. The handful of small pure functions below (type,
// geometry, response-shaping) are duplicated from observation-utils.ts
// rather than imported, on purpose -- keep it that way.
import { TVC_BOUNDARY } from './tvc-boundary';
import type { Observation } from './observation-utils';

const API = 'https://api.inaturalist.org/v1/observations';
const PROJECT_SLUG = 'biodiversity-at-tvc';

function toLatLng(geojson: Observation['geojson']): [number, number] | null {
  if (!geojson || !Array.isArray(geojson.coordinates) || geojson.coordinates.length !== 2) return null;
  const [lng, lat] = geojson.coordinates;
  return [lat, lng];
}

function isPointInPolygon(lat: number, lng: number, polygon: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [latI, lngI] = polygon[i];
    const [latJ, lngJ] = polygon[j];
    const crosses = latI > lat !== latJ > lat && lng < ((lngJ - lngI) * (lat - latI)) / (latJ - latI) + lngI;
    if (crosses) inside = !inside;
  }
  return inside;
}

function isWithinBoundary(geojson: Observation['geojson']): boolean {
  const latLng = toLatLng(geojson);
  if (!latLng) return false;
  return isPointInPolygon(latLng[0], latLng[1], TVC_BOUNDARY);
}

function toMinimalObservation(raw: any): Pick<Observation, 'geojson' | 'taxon'> {
  return {
    geojson: raw.geojson ?? null,
    taxon: raw.taxon ? { id: raw.taxon.id, name: raw.taxon.name, rank: raw.taxon.rank, preferred_common_name: raw.taxon.preferred_common_name ?? null, iconic_taxon_name: raw.taxon.iconic_taxon_name ?? null, parent_id: raw.taxon.parent_id ?? null, ancestor_ids: raw.taxon.ancestor_ids ?? [] } : null,
  };
}

async function fetchAllObservationsFresh(): Promise<Pick<Observation, 'geojson' | 'taxon'>[]> {
  const all: Pick<Observation, 'geojson' | 'taxon'>[] = [];
  let page = 1;
  // Defensive pagination loop — the whole project fits in one page today (100+
  // results, per_page max 200), but this holds up if it grows past that.
  while (true) {
    const res = await fetch(
      `${API}?project_id=${PROJECT_SLUG}&per_page=200&page=${page}&order_by=observed_on&order=desc`
    );
    if (!res.ok) throw new Error(`iNaturalist API error ${res.status}`);
    const data = await res.json();
    all.push(...data.results.map(toMinimalObservation));
    if (all.length >= data.total_results || data.results.length === 0) break;
    page += 1;
  }
  return all;
}

export async function fetchSpeciesCountFresh(): Promise<number> {
  const observations = await fetchAllObservationsFresh();
  const identified = observations.filter((o) => o.taxon != null && isWithinBoundary(o.geojson));
  return new Set(identified.map((o) => o.taxon!.id)).size;
}

// Reuses BiodiversityExplorer's own cache key/TTL convention (10 minutes) so
// a visitor who already opened /ecosystem this session resolves instantly
// from the SAME cached data that page reads -- just re-derives the species
// count from it here rather than importing observation-utils.ts's
// fetchAllObservations() to do so (see the file-level comment above).
export async function fetchSpeciesCount(): Promise<number> {
  const cacheKey = `tvc-biodiversity-cache-${PROJECT_SLUG}`;
  const cached = localStorage.getItem(cacheKey);
  if (cached) {
    try {
      const parsed = JSON.parse(cached);
      if (Date.now() - parsed.fetchedAt < 10 * 60 * 1000) {
        const identified = (parsed.observations as Observation[]).filter((o) => o.taxon != null && isWithinBoundary(o.geojson));
        return new Set(identified.map((o) => o.taxon!.id)).size;
      }
    } catch {
      // fall through to a fresh fetch
    }
  }
  return fetchSpeciesCountFresh();
}

// A tiny, dedicated cache just for the homepage's species-count stat tile —
// a couple dozen bytes, cheap enough to read synchronously wherever it's
// needed instead of the ~5MB raw-observations cache above.
const SPECIES_COUNT_CACHE_KEY = `tvc-species-count-${PROJECT_SLUG}`;

export function getCachedSpeciesCount(): number | null {
  try {
    const cached = localStorage.getItem(SPECIES_COUNT_CACHE_KEY);
    if (!cached) return null;
    const parsed = JSON.parse(cached);
    return typeof parsed.count === 'number' ? parsed.count : null;
  } catch {
    return null;
  }
}

export function setCachedSpeciesCount(count: number): void {
  try {
    localStorage.setItem(SPECIES_COUNT_CACHE_KEY, JSON.stringify({ count, cachedAt: Date.now() }));
  } catch {
    // Best-effort — a full localStorage quota just means the next visit
    // falls back to the "—" placeholder again, not a broken page.
  }
}
