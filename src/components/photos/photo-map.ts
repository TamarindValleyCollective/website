// Same Leaflet + OpenStreetMap setup as src/components/biodiversity/observation-map.ts
// (see that file for the iNaturalist version) - deliberately not shared code,
// since the two markers render very differently (photo thumbnail vs. a
// colored taxon dot) and the two collections' shapes don't overlap.
import L from 'leaflet';

export interface MapPhoto {
  slug: string;
  src: string;
  thumbSrc?: string;
  caption: string;
  gps: { lat: number; lng: number };
}

function thumbIcon(url: string) {
  return L.divIcon({
    className: 'photo-marker',
    html: `<span class="photo-marker__thumb"><img src="${url}" alt="" loading="lazy" /></span>`,
    iconSize: [36, 36],
    iconAnchor: [18, 36],
    popupAnchor: [0, -32],
  });
}

export function initPhotoMap(containerId: string, photos: MapPhoto[], onSelect: (slug: string) => void) {
  const map = L.map(containerId, { scrollWheelZoom: false });

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxZoom: 19,
  }).addTo(map);

  const markers: L.Marker[] = [];

  for (const photo of photos) {
    const thumb = photo.thumbSrc ?? photo.src;
    const marker = L.marker([photo.gps.lat, photo.gps.lng], { icon: thumbIcon(thumb) });

    marker.bindPopup(
      `<div class="photo-popup"><img src="${thumb}" alt="" /><strong>${photo.caption}</strong><br /><a href="#" data-photo-slug="${photo.slug}">View photo</a></div>`
    );
    marker.on('popupopen', () => {
      const link = document.querySelector(`a[data-photo-slug="${photo.slug}"]`);
      link?.addEventListener('click', (e) => {
        e.preventDefault();
        onSelect(photo.slug);
      });
    });

    marker.addTo(map);
    markers.push(marker);
  }

  if (markers.length > 0) {
    const group = L.featureGroup(markers);
    // maxZoom keeps a single (or tightly clustered) photo from fitBounds
    // zooming in past the point where OSM has tiles for a rural area.
    map.fitBounds(group.getBounds().pad(0.2), { maxZoom: 15 });
  } else {
    // Falls back to roughly the farm's location (Kanakapura/Thaggatti area)
    // when nothing in the current filter has GPS data.
    map.setView([12.35, 77.65], 13);
  }

  return map;
}
