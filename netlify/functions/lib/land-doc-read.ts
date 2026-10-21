// Pulls the text out of an uploaded PDF and runs it through the land-document templates
// (scripts/lib/member-land-docs.mjs, parseLandPdfText). Pure JavaScript (unpdf bundles
// pdf.js), so it runs in a Netlify Function with no binary and no external service: the
// file never leaves our systems.
//
// Returns null for anything the templates don't recognise (a scan, a photo, another kind of
// document, a PDF we can't open); the caller sends those to the core team instead.
import { extractImages, extractText, getDocumentProxy, getResolvedPDFJS } from 'unpdf';
import { pickSketch, shapeFromLines, shapeFromSketch, strokedLinesFromOps } from '../../../scripts/lib/land-shape.mjs';
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

// The outline of the parcel from the field sketch (the FMB sketch) as a transparent PNG with no
// labels on it. Null when there is no sketch or no outline can be found in it: the shape is a
// nicety, never a reason to refuse a document.
// The sketch is page 2 of a single-survey Integrated Land Record. With `standalone` it is the first
// page of an FMB-sketch-only download instead; that is only asked of a file the member said is a
// sketch, because the first page of a patta is a table, whose ruled lines are not a parcel.
// It is drawn either as a bitmap or as vector lines (the files e-Services makes now); both are tried.
export async function readLandShape(bytes: Uint8Array, { standalone = false }: { standalone?: boolean } = {}): Promise<Uint8Array | null> {
  try {
    const pdf = await getDocumentProxy(bytes.slice());
    const pageNo = standalone ? 1 : 2;
    if (pdf.numPages < pageNo || pdf.numPages > 10) return null;
    const bitmap = pickSketch(await extractImages(pdf, pageNo));
    const fromBitmap = bitmap ? shapeFromSketch(bitmap)?.png : null;
    if (fromBitmap) return fromBitmap;
    const page = await pdf.getPage(pageNo);
    const { OPS } = await getResolvedPDFJS();
    const lines = strokedLinesFromOps(await page.getOperatorList(), OPS, page.view);
    return shapeFromLines(lines, { width: page.view[2] - page.view[0], height: page.view[3] - page.view[1] })?.png ?? null;
  } catch (err) {
    console.error('[land-doc-read] could not read the sketch', err);
    return null;
  }
}
