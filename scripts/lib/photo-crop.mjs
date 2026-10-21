// Centring and zooming a photo inside the circle before it is uploaded. Pure (no DOM), so the maths is
// tested on its own; the portal's crop dialog (src/pages/members/index.astro) draws with it and
// scripts/lib/photo-prepare.mjs cuts the card's square from the rectangle it gives.
//
// The state is { zoom, cx, cy }: the square the circle shows is min(width, height) / zoom pixels across,
// centred on (cx, cy) in picture pixels. Zoom 1 is the largest centred square, which is exactly what an
// upload without the dialog used to give.

export const MAX_ZOOM = 4;

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

// The state the dialog opens with.
export const initialCrop = (width, height) => clampCrop({ zoom: 1, cx: width / 2, cy: height / 2 }, width, height);

// A state the square of which is inside the picture and the zoom inside 1..MAX_ZOOM, whatever was asked for.
export function clampCrop({ zoom, cx, cy }, width, height) {
  const z = Number.isFinite(zoom) ? clamp(zoom, 1, MAX_ZOOM) : 1;
  const half = Math.min(width, height) / z / 2;
  return {
    zoom: z,
    cx: clamp(Number.isFinite(cx) ? cx : width / 2, half, width - half),
    cy: clamp(Number.isFinite(cy) ? cy : height / 2, half, height - half),
  };
}

// A new zoom level around the same centre.
export const zoomTo = (state, zoom, width, height) => clampCrop({ ...state, zoom }, width, height);

// Dragging the picture by (dx, dy) pixels inside a viewSize-pixel circle moves the window over the picture the opposite
// way, by that many circle pixels scaled to picture pixels.
export function panBy(state, dx, dy, viewSize, width, height) {
  const scale = Math.min(width, height) / state.zoom / viewSize;
  return clampCrop({ ...state, cx: state.cx - dx * scale, cy: state.cy - dy * scale }, width, height);
}

// The square of the picture to cut, in whole pixels, always inside it.
export function cropRect(state, width, height) {
  const { zoom, cx, cy } = clampCrop(state, width, height);
  const side = Math.max(1, Math.min(Math.round(Math.min(width, height) / zoom), width, height));
  return {
    sx: clamp(Math.round(cx - side / 2), 0, width - side),
    sy: clamp(Math.round(cy - side / 2), 0, height - side),
    side,
  };
}
