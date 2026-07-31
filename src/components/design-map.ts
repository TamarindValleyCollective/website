// Same Leaflet + OpenStreetMap setup as corridor-map.ts and
// biodiversity/observation-map.ts, but at property scale: renders the TVC
// boundary plus every structure/plot/zone from TVC_LAYOUT (see
// src/data/tvc-layout.ts for where that data comes from). Replaces an
// embedded Google My Maps iframe so the design page's map is self-hosted
// and doesn't depend on Google's map tiles/quota.
import L from 'leaflet';
import { TVC_BOUNDARY } from './biodiversity/tvc-boundary';
import { TVC_LAYOUT, type LayoutCategory, type LayoutFeature } from '../data/tvc-layout';

const CATEGORY_COLORS: Record<LayoutCategory, string> = {
  structures: '#bd7248',
  farmPlots: '#5b8c3e',
  foodForest: '#17723b',
  water: '#2e7d8a',
  housing: '#8a5a2e',
  infrastructure: '#4a4a4a',
  landmark: '#a13b2e',
};

const CATEGORY_LABELS: Record<'en' | 'kn' | 'ta', Record<LayoutCategory, string>> = {
  en: {
    structures: 'Structures & camp',
    farmPlots: 'Farm plots',
    foodForest: 'Food forest',
    water: 'Water',
    housing: 'Housing',
    infrastructure: 'Infrastructure',
    landmark: 'Landmarks',
  },
  kn: {
    structures: 'ರಚನೆಗಳು ಮತ್ತು ಶಿಬಿರ',
    farmPlots: 'ಕೃಷಿ ಪ್ಲಾಟ್‌ಗಳು',
    foodForest: 'ಆಹಾರ ಅರಣ್ಯ',
    water: 'ನೀರು',
    housing: 'ವಸತಿ',
    infrastructure: 'ಮೂಲಸೌಕರ್ಯ',
    landmark: 'ಹೆಗ್ಗುರುತುಗಳು',
  },
  ta: {
    structures: 'கட்டமைப்புகள் & முகாம்',
    farmPlots: 'பண்ணை நிலங்கள்',
    foodForest: 'உணவு காடு',
    water: 'நீர்',
    housing: 'வீட்டு வசதி',
    infrastructure: 'உள்கட்டமைப்பு',
    landmark: 'அடையாளங்கள்',
  },
};

// Category order the legend renders in - landmark last since it's the
// smallest, most miscellaneous bucket (the property label pin + notable
// trees), not a zone type someone's scanning the legend for.
const CATEGORY_ORDER: LayoutCategory[] = ['housing', 'structures', 'farmPlots', 'foodForest', 'water', 'infrastructure', 'landmark'];

function dotIcon(color: string) {
  return L.divIcon({
    className: 'design-marker',
    html: `<span style="background:${color}"></span>`,
    iconSize: [12, 12],
  });
}

function addFeature(map: L.Map, feature: LayoutFeature) {
  const color = CATEGORY_COLORS[feature.category];
  const tooltipOpts: L.TooltipOptions = { sticky: true, direction: 'top' };

  if (feature.type === 'point') {
    const [lat, lng] = feature.coords as [number, number];
    L.marker([lat, lng], { icon: dotIcon(color) }).bindTooltip(feature.name, tooltipOpts).addTo(map);
    return;
  }

  const latLngs = feature.coords as [number, number][];
  if (feature.type === 'polygon') {
    L.polygon(latLngs, {
      color,
      weight: 1.5,
      fillOpacity: 0.3,
      dashArray: feature.planned ? '6,4' : undefined,
    })
      .bindTooltip(feature.name, tooltipOpts)
      .addTo(map);
    return;
  }

  // Swales, etc.
  L.polyline(latLngs, { color, weight: 2, dashArray: '4,4' }).bindTooltip(feature.name, tooltipOpts).addTo(map);
}

function addLegend(map: L.Map, lang: 'en' | 'kn' | 'ta') {
  const labels = CATEGORY_LABELS[lang] ?? CATEGORY_LABELS.en;
  const legend = new L.Control({ position: 'bottomright' });

  legend.onAdd = () => {
    const div = L.DomUtil.create('div', 'design-map-legend');
    div.innerHTML = CATEGORY_ORDER.map(
      (cat) => `<span class="design-map-legend__item"><i style="background:${CATEGORY_COLORS[cat]}"></i>${labels[cat]}</span>`
    ).join('');
    return div;
  };

  legend.addTo(map);
}

export function initDesignMap(containerId: string, lang: 'en' | 'kn' | 'ta' = 'en') {
  const map = L.map(containerId, { scrollWheelZoom: false });

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxZoom: 19,
  }).addTo(map);

  const boundary = L.polygon(TVC_BOUNDARY, {
    color: '#294a36',
    weight: 2,
    fill: false,
  }).addTo(map);

  for (const feature of TVC_LAYOUT) {
    addFeature(map, feature);
  }

  addLegend(map, lang);

  map.fitBounds(boundary.getBounds().pad(0.06));

  return map;
}
