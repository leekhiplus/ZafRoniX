/**
 * Output planning. Pure functions, no imports.
 *
 * The neural network (WebSR / Anime4K CNN) doubles the size of every frame. Everything the
 * UI promises about output resolution comes from these functions, using real source
 * dimensions, so the numbers on screen match what the worker will actually produce.
 */

// ---------------------------------------------------------------- video

export interface VideoLimits {
  /** Longest side allowed in the output (1920 for a 1080p cap). */
  maxLongEdge: number;
  /** Shortest side allowed in the output (1080 for a 1080p cap). */
  maxShortEdge: number;
  /** Minimum useful gain. Below this the video is treated as already at the cap. */
  minGain: number;
  /** Smallest accepted source side, in pixels. */
  minSide: number;
}

export const DEFAULT_VIDEO_LIMITS: VideoLimits = {
  maxLongEdge: 1920,
  maxShortEdge: 1080,
  minGain: 1.1,
  minSide: 64,
};

export interface VideoPlan {
  srcW: number;
  srcH: number;
  /** Size the neural network produces (always 2x the source). */
  aiW: number;
  aiH: number;
  /** Final encoded size. */
  outW: number;
  outH: number;
  /** outW / srcW */
  scale: number;
  /** 'native-2x': network output is encoded as is. 'fit': network output is resized down to the cap. */
  mode: 'native-2x' | 'fit';
}

export type PlanResult<T> = { ok: true; plan: T } | { ok: false; reason: string };

const evenDown = (v: number) => Math.max(2, Math.floor(v / 2) * 2);

export function planVideoOutput(srcW: number, srcH: number, limits: VideoLimits = DEFAULT_VIDEO_LIMITS): PlanResult<VideoPlan> {
  if (!Number.isFinite(srcW) || !Number.isFinite(srcH) || srcW <= 0 || srcH <= 0) {
    return { ok: false, reason: 'The video size could not be read.' };
  }
  if (Math.min(srcW, srcH) < limits.minSide) {
    return { ok: false, reason: `This video is too small (${srcW}×${srcH}). The minimum is ${limits.minSide}px on the short side.` };
  }
  const long = Math.max(srcW, srcH);
  const short = Math.min(srcW, srcH);
  const fit = Math.min(limits.maxLongEdge / long, limits.maxShortEdge / short);
  if (fit < limits.minGain) {
    return {
      ok: false,
      reason: `This video is already ${srcW}×${srcH}, at or near the 1080p limit. Zafronix upscales videos that are smaller than 1080p.`,
    };
  }
  const aiW = srcW * 2;
  const aiH = srcH * 2;
  if (fit >= 2) {
    return { ok: true, plan: { srcW, srcH, aiW, aiH, outW: aiW, outH: aiH, scale: 2, mode: 'native-2x' } };
  }
  const outW = evenDown(srcW * fit);
  const outH = evenDown(srcH * fit);
  return { ok: true, plan: { srcW, srcH, aiW, aiH, outW, outH, scale: outW / srcW, mode: 'fit' } };
}

export type VideoQuality = 'standard' | 'high';

/** Bits per pixel per frame fed to the H.264 encoder. */
const BITS_PER_PIXEL: Record<VideoQuality, number> = { standard: 0.08, high: 0.13 };

export const AUDIO_BITRATE = 128_000;

export function videoBitrate(outW: number, outH: number, fps: number, quality: VideoQuality): number {
  const raw = outW * outH * fps * BITS_PER_PIXEL[quality];
  return Math.round(Math.min(24_000_000, Math.max(1_000_000, raw)));
}

export function keyframeInterval(fps: number): number {
  return Math.max(1, Math.round(fps * 2));
}

export function estimateVideoOutputBytes(outW: number, outH: number, fps: number, durationSec: number, quality: VideoQuality, withAudio: boolean): number {
  const bps = videoBitrate(outW, outH, fps, quality) + (withAudio ? AUDIO_BITRATE : 0);
  return Math.round((bps / 8) * durationSec);
}

// ---------------------------------------------------------------- image

export interface ImageLimits {
  /** Longest side allowed in the output. Also bounded by the GPU texture limit. */
  maxLongEdge: number;
  /** Largest output area in pixels (7680 x 4320 = 8K UHD). */
  maxPixels: number;
  minSide: number;
}

export const DEFAULT_IMAGE_LIMITS: ImageLimits = {
  maxLongEdge: 8192,
  maxPixels: 7680 * 4320,
  minSide: 16,
};

export type ImageScale = 2 | 4;

export interface ImagePlan {
  srcW: number;
  srcH: number;
  scale: ImageScale;
  /** 1 pass for 2x, 2 passes for 4x (the 2x network is applied twice). */
  passes: 1 | 2;
  outW: number;
  outH: number;
}

export function planImageOutput(srcW: number, srcH: number, scale: ImageScale, limits: ImageLimits = DEFAULT_IMAGE_LIMITS): PlanResult<ImagePlan> {
  if (!Number.isFinite(srcW) || !Number.isFinite(srcH) || srcW <= 0 || srcH <= 0) {
    return { ok: false, reason: 'The image size could not be read.' };
  }
  if (Math.min(srcW, srcH) < limits.minSide) {
    return { ok: false, reason: `This image is too small (${srcW}×${srcH}). The minimum is ${limits.minSide}px on the short side.` };
  }
  const outW = srcW * scale;
  const outH = srcH * scale;
  if (Math.max(outW, outH) > limits.maxLongEdge) {
    return {
      ok: false,
      reason: `${scale}x would make this image ${outW}×${outH}. The longest side is limited to ${limits.maxLongEdge}px (GPU texture limit).`,
    };
  }
  if (outW * outH > limits.maxPixels) {
    return {
      ok: false,
      reason: `${scale}x would make this image ${outW}×${outH}, above the 8K limit of 7680×4320.`,
    };
  }
  return { ok: true, plan: { srcW, srcH, scale, passes: scale === 2 ? 1 : 2, outW, outH } };
}

/** Which scales can be offered for this image, and why the others cannot. */
export function imageScaleOptions(srcW: number, srcH: number, limits: ImageLimits = DEFAULT_IMAGE_LIMITS): { scale: ImageScale; available: boolean; reason?: string }[] {
  return ([2, 4] as ImageScale[]).map((scale) => {
    const r = planImageOutput(srcW, srcH, scale, limits);
    return r.ok ? { scale, available: true } : { scale, available: false, reason: r.reason };
  });
}

/** Rough weight of an image job, used only to show a heads-up. Based on output pixels, not a measurement. */
export function imageLoadLevel(outW: number, outH: number): 'normal' | 'heavy' | 'very-heavy' {
  const px = outW * outH;
  if (px >= 24_000_000) return 'very-heavy';
  if (px >= 12_000_000) return 'heavy';
  return 'normal';
}
