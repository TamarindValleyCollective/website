// Pulls the text out of an uploaded PDF and runs it through the land-document templates
// (scripts/lib/member-land-docs.mjs, parseLandPdfText). Pure JavaScript (unpdf bundles
// pdf.js), so it runs in a Netlify Function with no binary and no external service: the
// file never leaves our systems.
//
// Returns null for anything the templates don't recognise (a scan, a photo, another kind of
// document, a PDF we can't open); the caller sends those to the core team instead.
import { extractImages, extractText, getDocumentProxy } from 'unpdf';
import { pickSketch, shapeFromSketch } from '../../../scripts/lib/land-shape.mjs';
import { parseLandPdfText } from '../../../scripts/lib/member-land-docs.mjs';

export async function readLandPdf(bytes: Uint8Array): Promise<unknown | null> {
  try {
    // pdf.js takes ownership of the buffer it is given (it is emptied afterwards), and the caller
    // still has to store these bytes, so hand it a copy.
    const pdf = await getDocumentProxy(bytes.slice());
    if (pdf.numPages > 10) return null; // these extracts are two pages; a long file is something else
    const { text } = await extractText(pdf, { mergePages: false });
    return parseLandPdfText(Array.isArray(text) ? text : [text]);
  } catch (err) {
    console.error('[land-doc-read] could not read the PDF', err);
    return null;
  }
}

// The outline of the parcel from the field sketch on page 2 of a single-survey Integrated Land
// Record, as a transparent PNG with no labels on it. Null when there is no sketch or no outline
// can be found in it: the shape is a nicety, never a reason to refuse a document.
export async function readLandShape(bytes: Uint8Array): Promise<Uint8Array | null> {
  try {
    const pdf = await getDocumentProxy(bytes.slice());
    if (pdf.numPages < 2 || pdf.numPages > 10) return null;
    const sketch = pickSketch(await extractImages(pdf, 2));
    return sketch ? (shapeFromSketch(sketch)?.png ?? null) : null;
  } catch (err) {
    console.error('[land-doc-read] could not read the sketch', err);
    return null;
  }
}
