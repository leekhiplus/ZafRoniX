/**
 * Pure formatting helpers. No imports, so they can be unit-tested directly in Node.
 */

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '-';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = -1;
  do {
    value /= 1024;
    unit++;
  } while (value >= 1024 && unit < units.length - 1);
  const digits = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  // Drop trailing zeros: "1.50 GB" -> "1.5 GB", "5.00 MB" -> "5 MB".
  return `${Number(value.toFixed(digits))} ${units[unit]}`;
}

/** 83 -> "1:23", 3725 -> "1:02:05". */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '-';
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, '0');
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${ss}`;
  return `${m}:${ss}`;
}

/** Friendly label for a resolution, based on the real pixel dimensions. */
export function resolutionLabel(width: number, height: number): string {
  const long = Math.max(width, height);
  const short = Math.min(width, height);
  if (long >= 7600) return '8K';
  if (long >= 5000) return '5K';
  if (long >= 3800) return '4K';
  if (short >= 1400) return '1440p';
  if (short >= 1060) return '1080p';
  if (short >= 700) return '720p';
  if (short >= 460) return '480p';
  if (short >= 340) return '360p';
  return 'SD';
}

export function formatResolution(width: number, height: number): string {
  return `${width}×${height}`;
}

export function fileExtension(name: string): string {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i).toLowerCase() : '';
}

/**
 * Turns a user's file name into a safe base name for the download.
 * Keeps letters and numbers from any language (so Urdu names survive).
 */
export function sanitizeBaseName(name: string, fallback = 'file'): string {
  // Browsers never include a path in File.name, but never trust that: keep only the last segment.
  const leaf = name.split(/[\\/]/).pop() ?? '';
  const dot = leaf.lastIndexOf('.');
  const base = dot > 0 ? leaf.slice(0, dot) : leaf;
  const cleaned = base
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-._]+|[-._]+$/g, '')
    .slice(0, 80);
  return cleaned || fallback;
}

/** "My Clip.MOV" + "zafronix-1080p" + "mp4" -> "My-Clip-zafronix-1080p.mp4" */
export function outputFileName(originalName: string, suffix: string, extension: string, fallback = 'file'): string {
  const ext = extension.replace(/^\./, '');
  return `${sanitizeBaseName(originalName, fallback)}-${suffix}.${ext}`;
}

/** Remaining-time text. Returns null until there is enough real data to estimate. */
export function estimateRemainingSeconds(ratio: number, elapsedMs: number, minRatio = 0.03, minElapsedMs = 3000): number | null {
  if (!(ratio >= minRatio) || ratio >= 1 || elapsedMs < minElapsedMs) return null;
  const totalMs = elapsedMs / ratio;
  return Math.max(0, Math.round((totalMs - elapsedMs) / 1000));
}
