// Draws a QR code as an inline SVG, entirely in the browser (used by
// /internal/security to show the authenticator-app setup code). The text
// being encoded contains a secret, so it must never leave the page: this
// module makes no network request and does not use an online QR service.
//
// Kept in its own file, with the document passed in, so it can be tested
// without a browser: a test decodes what this draws with a real QR reader.
import qrcode from 'qrcode-generator';

const SVG_NS = 'http://www.w3.org/2000/svg';
const QUIET_ZONE = 4; // modules of blank border the QR spec requires

// Error-correction level M (about 15% of the code can be damaged and it still
// scans), automatic version. Byte mode: the otpauth:// text is plain ASCII.
export function qrModules(text) {
  const qr = qrcode(0, 'M');
  qr.addData(text, 'Byte');
  qr.make();
  const size = qr.getModuleCount();
  return { size, isDark: (row, col) => qr.isDark(row, col) };
}

// One SVG path for every dark module, merged into horizontal runs so the
// markup stays small. Coordinates are in modules; the viewBox adds the quiet
// zone.
export function qrPathData(text) {
  const { size, isDark } = qrModules(text);
  let d = '';
  for (let row = 0; row < size; row++) {
    let col = 0;
    while (col < size) {
      if (!isDark(row, col)) {
        col++;
        continue;
      }
      const start = col;
      while (col < size && isDark(row, col)) col++;
      const run = col - start;
      d += `M${start} ${row}h${run}v1h-${run}z`;
    }
  }
  return { size, path: d };
}

// Builds the <svg> with DOM calls only (no innerHTML). Dark modules use the
// site's ink token on an explicit white square, so it scans regardless of the
// page background.
export function buildQrSvg(doc, text, label) {
  const { size, path } = qrPathData(text);
  const total = size + QUIET_ZONE * 2;
  const svg = doc.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `${-QUIET_ZONE} ${-QUIET_ZONE} ${total} ${total}`);
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', label);
  svg.setAttribute('shape-rendering', 'crispEdges');
  svg.style.width = '100%';
  svg.style.maxWidth = '220px';
  svg.style.height = 'auto';
  svg.style.display = 'block';

  const bg = doc.createElementNS(SVG_NS, 'rect');
  bg.setAttribute('x', String(-QUIET_ZONE));
  bg.setAttribute('y', String(-QUIET_ZONE));
  bg.setAttribute('width', String(total));
  bg.setAttribute('height', String(total));
  bg.style.fill = 'var(--tvc-white)';

  const fg = doc.createElementNS(SVG_NS, 'path');
  fg.setAttribute('d', path);
  fg.style.fill = 'var(--tvc-ink)';

  svg.append(bg, fg);
  return svg;
}
