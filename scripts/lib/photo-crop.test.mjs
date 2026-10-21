// Run with: node --test scripts/lib/photo-crop.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_ZOOM, clampCrop, cropRect, initialCrop, panBy, zoomTo } from './photo-crop.mjs';

test('at zoom 1 the crop is the largest centred square, exactly what an upload without a dialog gave', () => {
  assert.deepEqual(cropRect(initialCrop(1600, 1000), 1600, 1000), { sx: 300, sy: 0, side: 1000 }); // landscape
  assert.deepEqual(cropRect(initialCrop(900, 1200), 900, 1200), { sx: 0, sy: 150, side: 900 }); // portrait
  assert.deepEqual(cropRect(initialCrop(800, 800), 800, 800), { sx: 0, sy: 0, side: 800 }); // already square
});

test('zooming in shows a smaller square of the picture, around the same centre', () => {
  const state = zoomTo(initialCrop(1600, 1000), 2, 1600, 1000);
  assert.deepEqual(cropRect(state, 1600, 1000), { sx: 550, sy: 250, side: 500 });
  assert.deepEqual(cropRect(zoomTo(initialCrop(1600, 1000), 4, 1600, 1000), 1600, 1000), { sx: 675, sy: 375, side: 250 });
});

test('zoom stays between 1x and the maximum, whatever is asked for', () => {
  assert.equal(MAX_ZOOM, 4);
  assert.equal(zoomTo(initialCrop(1600, 1000), 9, 1600, 1000).zoom, 4);
  assert.equal(zoomTo(initialCrop(1600, 1000), 0.2, 1600, 1000).zoom, 1);
  assert.equal(clampCrop({ zoom: Number.NaN, cx: 800, cy: 500 }, 1600, 1000).zoom, 1); // garbage in is the plain crop out
});

test('the square can never leave the picture: a centre past an edge is pulled back in', () => {
  const edge = clampCrop({ zoom: 2, cx: -300, cy: 99999 }, 1600, 1000); // a 500px square: centre within 250..1350 and 250..750
  assert.deepEqual([edge.cx, edge.cy], [250, 750]);
  const r = cropRect(edge, 1600, 1000);
  assert.ok(r.sx >= 0 && r.sy >= 0 && r.sx + r.side <= 1600 && r.sy + r.side <= 1000);
  // at zoom 1 on a landscape picture there is no room to move up or down, only to the sides
  const flat = clampCrop({ zoom: 1, cx: 100, cy: 5 }, 1600, 1000);
  assert.deepEqual([flat.cx, flat.cy], [500, 500]);
});

test('dragging the picture moves the window the opposite way, scaled from circle pixels to picture pixels', () => {
  // a 250px circle showing a 1000px square: one pixel dragged is four picture pixels
  const start = initialCrop(1600, 1000); // centre 800, 500
  const right = panBy(start, 50, 0, 250, 1600, 1000); // drag the picture 50px to the right: the window moves 200px left
  assert.equal(right.cx, 600);
  const up = panBy(zoomTo(start, 2, 1600, 1000), 0, -50, 250, 1600, 1000); // zoom 2: the window is 500px, so 1px = 2 picture px; dragging up moves the window down
  assert.equal(up.cy, 500 + 100);
  assert.equal(panBy(start, 9999, 0, 250, 1600, 1000).cx, 500); // clamped at the edge, not off the picture
});

test('the rectangle is whole pixels inside the picture, even from awkward zooms', () => {
  for (const zoom of [1, 1.37, 2.5, 3.99, 4]) {
    for (const [cx, cy] of [[0, 0], [1600, 1000], [333.3, 777.7]]) {
      const r = cropRect({ zoom, cx, cy }, 1600, 1000);
      assert.ok(Number.isInteger(r.sx) && Number.isInteger(r.sy) && Number.isInteger(r.side), `${zoom} ${cx} ${cy}`);
      assert.ok(r.sx >= 0 && r.sy >= 0 && r.sx + r.side <= 1600 && r.sy + r.side <= 1000, `${zoom} ${cx} ${cy}`);
      assert.ok(r.side >= 1);
    }
  }
});
