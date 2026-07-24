import L from 'leaflet';
import type { Observation } from './observation-utils';
import { toLatLng, thumbUrl } from './observation-utils';
import { TVC_BOUNDARY } from './tvc-boundary';

// Marker colors keyed by iconic taxon — matches the filter chip colors so the
// map and the chips read as one system.
const GROUP_COLORS: Record<string, string> = {
  Aves: '#17723b',
  Insecta: '#f78520',
  Plantae: '#5b8c3e',
  Mammalia: '#8a5a2e',
  Reptilia: '#a13b2e',
  Amphibia: '#2e7d8a',
  Mollusca: '#7a5a9c',
  Arachnida: '#4a4a4a',
  Fungi: '#b8862e',
  Unknown: '#8a8a8a',
};

function colorFor(iconicTaxonName: string | null) {
  return GROUP_COLORS[iconicTaxonName ?? 'Unknown'] ?? GROUP_COLORS.Unknown;
}

function dotIcon(color: string) {
  return L.divIcon({
    className: 'obs-marker',
    html: `<span style="background:${color}"></span>`,
    iconSize: [14, 14],
  });
}

export function initMap(containerId: string, observations: Observation[], onSelect: (obs: Observation) => void) {
  const map = L.map(containerId, { scrollWheelZoom: false });

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxZoom: 19,
  }).addTo(map);

  // Shows what "within the boundary" means for the sightings plotted here —
  // observations outside this outline have already been filtered out
  // upstream (see isWithinBoundary in observation-utils.ts).
  const boundary = L.polygon(TVC_BOUNDARY, {
    color: '#17723b',
    weight: 2,
    fill: false,
  }).addTo(map);

  const markers: L.Marker[] = [];

  for (const obs of observations) {
    const latLng = toLatLng(obs.geojson);
    if (!latLng) continue;

    const marker = L.marker(latLng, { icon: dotIcon(colorFor(obs.taxon?.iconic_taxon_name ?? null)) });
    const thumb = obs.photos[0] ? thumbUrl(obs.photos[0].url) : '';
    const name = obs.taxon?.preferred_common_name || obs.taxon?.name || 'Unidentified';

    marker.bindPopup(
      `<div class="obs-popup">${thumb ? `<img src="${thumb}" alt="${name}" />` : ''}<strong>${name}</strong><br /><a href="#" data-obs-id="${obs.id}">View details</a></div>`
    );
    marker.on('popupopen', () => {
      const link = document.querySelector(`a[data-obs-id="${obs.id}"]`);
      link?.addEventListener('click', (e) => {
        e.preventDefault();
        onSelect(obs);
      });
    });

    marker.addTo(map);
    markers.push(marker);
  }

  if (markers.length > 0) {
    const group = L.featureGroup(markers);
    map.fitBounds(group.getBounds().pad(0.2));
  } else {
    // No markers for the current filter — fall back to framing the
    // boundary itself rather than an arbitrary fixed point/zoom.
    map.fitBounds(boundary.getBounds().pad(0.1));
  }

  return map;
}
