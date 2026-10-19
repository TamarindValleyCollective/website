// Pulls the text out of an uploaded PDF and runs it through the land-document templates
// (scripts/lib/member-land-docs.mjs, parseLandPdfText). Pure JavaScript (unpdf bundles
// pdf.js), so it runs in a Netlify Function with no binary and no external service: the
// file never leaves our systems.
//
// Returns null for anything the templates don't recognise (a scan, a photo, another kind of
// document, a PDF we can't open); the caller sends those to the core team instead.
import { extractText, getDocumentProxy } from 'unpdf';
import { parseLandPdfText } from '../../../scripts/lib/member-land-docs.mjs';

export async function readLandPdf(bytes: Uint8Array): Promise<unknown | null> {
  try {
    const pdf = await getDocumentProxy(bytes);
    if (pdf.numPages > 10) return null; // these extracts are two pages; a long file is something else
    const { text } = await extractText(pdf, { mergePages: false });
    return parseLandPdfText(Array.isArray(text) ? text : [text]);
  } catch (err) {
    console.error('[land-doc-read] could not read the PDF', err);
    return null;
  }
}
