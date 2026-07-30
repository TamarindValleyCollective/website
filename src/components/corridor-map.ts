// Same Leaflet + OpenStreetMap setup as src/components/photos/photo-map.ts
// and src/components/biodiversity/observation-map.ts -- deliberately not
// shared code, since this map's markers are simple labeled dots on a
// regional (not property-scale) view, not thumbnails or taxon icons.
import L from 'leaflet';
import { LAT, LNG } from '../utils/weather';
import { CORRIDOR_LANDMARKS } from '../data/corridor-landmarks';

const TVC_LABEL: Record<'en' | 'kn' | 'ta', string> = {
  en: 'Tamarind Valley Collective',
  kn: 'ತಮರಿಂಡ್ ವ್ಯಾಲಿ ಕಲೆಕ್ಟಿವ್',
  ta: 'டமரிண்ட் வேலி கலெக்டிவ்',
};

function dotIcon(variant: 'tvc' | 'landmark') {
  return L.divIcon({
    className: `corridor-marker corridor-marker--${variant}`,
    html: '<span></span>',
    iconSize: [14, 14],
    iconAnchor: [7, 7],
  });
}

export function initCorridorMap(containerId: string, lang: 'en' | 'kn' | 'ta' = 'en') {
  const map = L.map(containerId, { scrollWheelZoom: false });

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxZoom: 12,
  }).addTo(map);

  const markers: L.Marker[] = [];

  const tvcMarker = L.marker([LAT, LNG], { icon: dotIcon('tvc') }).bindTooltip(TVC_LABEL[lang] ?? TVC_LABEL.en, {
    direction: 'top',
    offset: [0, -4],
  });
  tvcMarker.addTo(map);
  markers.push(tvcMarker);

  for (const landmark of CORRIDOR_LANDMARKS) {
    const marker = L.marker([landmark.lat, landmark.lng], { icon: dotIcon('landmark') }).bindTooltip(
      landmark.label[lang] ?? landmark.label.en,
      { direction: 'top', offset: [0, -4] }
    );
    marker.addTo(map);
    markers.push(marker);
  }

  const group = L.featureGroup(markers);
  map.fitBounds(group.getBounds().pad(0.35));

  return map;
}
