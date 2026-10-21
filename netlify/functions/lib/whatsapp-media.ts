// Inbound WhatsApp media (photos, voice notes, video, documents, stickers).
// Pure helpers (no I/O) shared by whatsapp-webhook.mts, which records which
// media a message carries, and whatsapp-admin.mts, which fetches the file from
// Meta on demand for staff.
//
// We never store the file itself: Meta keeps media for about 30 days and hands
// out a short-lived download URL, so the inbox fetches it through the admin
// function when an admin looks. That keeps guests' photos out of our
// database and means they stop being viewable once Meta drops them.

export type MediaKind = 'image' | 'audio' | 'video' | 'document' | 'sticker';
export interface InboundMedia {
  id: string;
  kind: MediaKind;
  mime: string | null;
  filename: string | null;
}

const KINDS: MediaKind[] = ['image', 'audio', 'video', 'document', 'sticker'];

// Pulls the media descriptor out of an inbound message, if it has one.
export function extractMedia(message: any): InboundMedia | null {
  for (const kind of KINDS) {
    const m = message?.[kind];
    if (message?.type === kind && m?.id) {
      return { id: String(m.id), kind, mime: m.mime_type ? String(m.mime_type) : null, filename: m.filename ? String(m.filename) : null };
    }
  }
  return null;
}

// The text shown in the inbox row / list preview / unread digest.
export function describeMedia(message: any): string | null {
  const media = extractMedia(message);
  if (!media) return null;
  const caption = String(message[media.kind]?.caption ?? '').trim();
  switch (media.kind) {
    case 'image':
      return caption ? `[Photo] ${caption}` : '[Photo]';
    case 'video':
      return caption ? `[Video] ${caption}` : '[Video]';
    case 'audio':
      return message.audio?.voice ? '[Voice note]' : '[Audio]';
    case 'sticker':
      return '[Sticker]';
    case 'document': {
      const name = media.filename ? ` ${media.filename}` : '';
      return caption ? `[Document]${name} — ${caption}` : `[Document]${name}`;
    }
  }
}

// Types a browser can safely render inline from our origin. Everything else
// (documents, SVG, HTML, unknown) is only ever offered as a download, so a guest
// can't get a script to run in the admin inbox's origin by sending a crafted file.
const INLINE_MIME = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'audio/ogg',
  'audio/mpeg',
  'audio/mp4',
  'audio/aac',
  'audio/amr',
  'video/mp4',
  'video/3gpp',
]);

export function baseMime(mime: string | null | undefined): string {
  return String(mime ?? '').split(';')[0].trim().toLowerCase();
}

export const MAX_MEDIA_BYTES = 5.5 * 1024 * 1024; // Netlify Functions cap a response at ~6 MB

function safeFilename(name: string | null | undefined): string {
  const cleaned = String(name ?? 'file').replace(/[^\w.\- ]+/g, '_').trim();
  return cleaned.slice(0, 80) || 'file';
}

// Response headers for serving a guest's file to an admin.
export function mediaResponseHeaders(mime: string | null | undefined, filename: string | null | undefined): Record<string, string> {
  const base = baseMime(mime);
  const inline = INLINE_MIME.has(base);
  return {
    'content-type': inline ? base : 'application/octet-stream',
    ...(inline ? {} : { 'content-disposition': `attachment; filename="${safeFilename(filename)}"` }),
    'x-content-type-options': 'nosniff',
    // Belt and braces: even if a browser rendered it, nothing could run or load.
    'content-security-policy': "default-src 'none'; sandbox",
    'cache-control': 'private, max-age=300',
  };
}
