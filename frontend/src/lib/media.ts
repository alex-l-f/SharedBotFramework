// What kind of media a delivered file is (shared by the admin chat and the
// standalone chat page): from its media type, else its type and extensions.

export type MediaKind = 'video' | 'audio' | 'image' | 'pdf' | 'other';

const VIDEO = ['video', 'mp4', 'webm', 'mov', 'm4v', 'ogv', 'wmv', 'avi', 'mkv'];
const AUDIO = ['audio', 'mp3', 'wav', 'm4a', 'ogg', 'oga', 'aac', 'flac', 'opus'];
const IMAGE = ['image', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'];

function extension(name: string): string {
  const clean = name.split(/[?#]/)[0];
  const dot = clean.lastIndexOf('.');
  return dot >= 0 && dot > clean.lastIndexOf('/') ? clean.slice(dot + 1).toLowerCase() : '';
}

export function mediaKind(o: { source_type: string; source_file: string; url: string; mime?: string | null }): MediaKind {
  const mime = (o.mime || '').toLowerCase();
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('image/')) return 'image';
  if (mime === 'application/pdf') return 'pdf';
  const type = (o.source_type || '').toLowerCase();
  const exts = [extension(o.source_file || ''), extension(o.url || '')].filter(Boolean);
  const has = (list: string[]) => list.includes(type) || exts.some((e) => list.includes(e)) || list.some((l) => type.startsWith(`${l}/`));
  if (has(VIDEO)) return 'video';
  if (has(AUDIO)) return 'audio';
  if (has(IMAGE)) return 'image';
  if (type === 'pdf' || exts.includes('pdf') || type === 'application/pdf') return 'pdf';
  return 'other';
}
