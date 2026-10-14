/**
 * File validation. Pure functions, no imports.
 *
 * Extension and MIME type are both checked. Browsers sometimes report an empty MIME type
 * (common for .mkv), so an empty type is accepted if the extension is on the allow-list.
 * The real test of whether a file can be decoded happens later, when the decoder opens it.
 */

export type MediaKind = 'video' | 'image';

export interface FileRules {
  extensions: readonly string[];
  mimeTypes: readonly string[];
  maxBytes: number;
}

export interface FileLike {
  name: string;
  type: string;
  size: number;
}

export type ValidationCode = 'empty' | 'extension' | 'mime' | 'too-large';

export type ValidationResult =
  | { ok: true }
  | { ok: false; code: ValidationCode; message: string };

function ext(name: string): string {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i).toLowerCase() : '';
}

function mb(bytes: number): string {
  const v = bytes / (1024 * 1024);
  return v >= 1024 ? `${(v / 1024).toFixed(1)} GB` : `${Math.round(v)} MB`;
}

export function validateFile(file: FileLike, rules: FileRules): ValidationResult {
  if (!file.size) {
    return { ok: false, code: 'empty', message: 'This file is empty (0 bytes). Choose a different file.' };
  }
  const e = ext(file.name);
  if (!rules.extensions.includes(e)) {
    const list = rules.extensions.join(', ');
    return {
      ok: false,
      code: 'extension',
      message: `${e ? `"${e}" files are` : 'Files without an extension are'} not supported here. Use one of: ${list}.`,
    };
  }
  const type = (file.type || '').toLowerCase();
  if (type && !rules.mimeTypes.includes(type)) {
    return {
      ok: false,
      code: 'mime',
      message: `The file reports its type as "${type}", which is not supported here.`,
    };
  }
  if (file.size > rules.maxBytes) {
    return {
      ok: false,
      code: 'too-large',
      message: `This file is ${mb(file.size)}. The limit is ${mb(rules.maxBytes)}.`,
    };
  }
  return { ok: true };
}

/**
 * Guess whether a dropped file is a video or an image, so a file dropped on the wrong
 * tab can be redirected instead of rejected.
 */
export function detectKind(file: Pick<FileLike, 'name' | 'type'>, videoExt: readonly string[], imageExt: readonly string[]): MediaKind | null {
  const type = (file.type || '').toLowerCase();
  if (type.startsWith('video/')) return 'video';
  if (type.startsWith('image/')) return 'image';
  const e = ext(file.name);
  if (videoExt.includes(e)) return 'video';
  if (imageExt.includes(e)) return 'image';
  return null;
}
