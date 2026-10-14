/**
 * Reads real metadata from a user's file using the browser's own decoders.
 * Callers own the returned object URL and must revoke it.
 */

export interface VideoMeta {
  url: string;
  width: number;
  height: number;
  /** Seconds. 0 if the container does not declare a duration. */
  duration: number;
}

export interface ImageMeta {
  url: string;
  width: number;
  height: number;
}

export function probeVideo(file: File, timeoutMs = 15000): Promise<VideoMeta> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.muted = true;

    const timer = window.setTimeout(() => fail(), timeoutMs);
    const cleanup = () => {
      window.clearTimeout(timer);
      video.onloadedmetadata = null;
      video.onerror = null;
      video.removeAttribute('src');
      video.load();
    };
    const fail = () => {
      cleanup();
      URL.revokeObjectURL(url);
      reject(new Error('unreadable'));
    };

    video.onloadedmetadata = () => {
      if (!video.videoWidth || !video.videoHeight) return fail();
      const meta: VideoMeta = {
        url,
        width: video.videoWidth,
        height: video.videoHeight,
        duration: Number.isFinite(video.duration) ? video.duration : 0,
      };
      cleanup();
      resolve(meta);
    };
    video.onerror = fail;
    video.src = url;
  });
}

export async function probeImage(file: File): Promise<ImageMeta> {
  const url = URL.createObjectURL(file);
  try {
    const bitmap = await createImageBitmap(file);
    const meta: ImageMeta = { url, width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return meta;
  } catch {
    URL.revokeObjectURL(url);
    throw new Error('unreadable');
  }
}
