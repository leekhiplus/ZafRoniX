/**
 * Honest capability detection. Each flag is the result of an actual browser query, not a
 * user-agent guess (the only exception is the "phone" flag, which only changes warnings).
 */

export interface Check {
  ok: boolean;
  /** Short text shown next to the indicator. */
  detail: string;
}

export interface Capabilities {
  webgpu: Check;
  video: Check;
  /** WebGPU + OffscreenCanvas + Worker: enough for images. */
  canUpscaleImages: boolean;
  /** WebGPU + WebCodecs decode + H.264 encode: enough for video. */
  canUpscaleVideo: boolean;
  softwareGpu: boolean;
  lowMemory: boolean;
  phone: boolean;
  maxTextureDimension: number | null;
}

function isPhone(): boolean {
  const uad = (navigator as any).userAgentData;
  if (uad && typeof uad.mobile === 'boolean') return uad.mobile;
  return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
}

async function checkWebGpu(): Promise<{ check: Check; software: boolean; maxTex: number | null }> {
  const gpu = (navigator as any).gpu;
  if (!gpu) {
    return { check: { ok: false, detail: 'Not available in this browser' }, software: false, maxTex: null };
  }
  try {
    const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) {
      return { check: { ok: false, detail: 'No compatible GPU found' }, software: false, maxTex: null };
    }
    let info: any = adapter.info;
    if (!info && typeof adapter.requestAdapterInfo === 'function') {
      try {
        info = await adapter.requestAdapterInfo();
      } catch {
        info = null;
      }
    }
    const software = Boolean(adapter.isFallbackAdapter || info?.isFallbackAdapter);
    const name = [info?.vendor, info?.architecture].filter(Boolean).join(' ') || info?.description || 'GPU ready';
    const maxTex = Number(adapter.limits?.maxTextureDimension2D) || null;
    return {
      check: { ok: true, detail: software ? `${name} (software, slow)` : name },
      software,
      maxTex,
    };
  } catch {
    return { check: { ok: false, detail: 'Could not start' }, software: false, maxTex: null };
  }
}

async function checkVideo(): Promise<Check> {
  const hasDecoder = typeof (window as any).VideoDecoder !== 'undefined';
  const hasEncoder = typeof (window as any).VideoEncoder !== 'undefined';
  if (!hasDecoder || !hasEncoder) return { ok: false, detail: 'WebCodecs missing' };
  try {
    const probe = { codec: 'avc1.4d0034', width: 1920, height: 1080, bitrate: 5_000_000, framerate: 30 };
    const support = await VideoEncoder.isConfigSupported(probe);
    if (!support.supported) return { ok: false, detail: 'H.264 encoding unavailable' };
  } catch {
    return { ok: false, detail: 'H.264 encoding unavailable' };
  }
  return { ok: true, detail: 'H.264 ready' };
}

export async function detectCapabilities(): Promise<Capabilities> {
  const [gpuResult, video] = await Promise.all([checkWebGpu(), checkVideo()]);
  const hasOffscreen = typeof OffscreenCanvas !== 'undefined' && typeof Worker !== 'undefined';
  const mem = Number((navigator as any).deviceMemory) || null;
  const phone = isPhone();

  return {
    webgpu: gpuResult.check,
    video,
    canUpscaleImages: gpuResult.check.ok && hasOffscreen,
    canUpscaleVideo: gpuResult.check.ok && hasOffscreen && video.ok,
    softwareGpu: gpuResult.software,
    lowMemory: phone || (mem !== null && mem <= 4),
    phone,
    maxTextureDimension: gpuResult.maxTex,
  };
}
