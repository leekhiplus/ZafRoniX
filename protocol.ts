/**
 * Typed message protocol between the page and the processing worker.
 * Types only: this file produces no runtime code.
 */
import type { ErrorCode } from '../lib/errors';

export type ModelSize = 'small' | 'medium' | 'large';
/** rl = real-life footage, an = animation / illustration, 3d = 3D / game renders */
export type ModelContent = 'rl' | 'an' | '3d';

export interface ModelChoice {
  size: ModelSize;
  content: ModelContent;
}

export type Stage = 'loading-model' | 'analyzing' | 'enhancing' | 'finalizing';

// ------------------------------------------------------------------ page -> worker

export interface VideoJobRequest {
  type: 'video';
  jobId: string;
  file: File;
  /** Absolute URL of the site root. Used to locate weights and the demuxer WASM. */
  baseUrl: string;
  model: ModelChoice;
  srcW: number;
  srcH: number;
  outW: number;
  outH: number;
  quality: 'standard' | 'high';
  keepAudio: boolean;
  /** Duration reported by the preview element, used only if the container has none. */
  durationHint: number;
}

export interface ImageJobRequest {
  type: 'image';
  jobId: string;
  file: File;
  baseUrl: string;
  model: ModelChoice;
  scale: 2 | 4;
  format: 'png' | 'jpeg' | 'webp';
  /** 0..1, used for jpeg and webp. */
  quality: number;
}

export type MainToWorker = VideoJobRequest | ImageJobRequest;

// ------------------------------------------------------------------ worker -> page

export interface VideoDoneInfo {
  width: number;
  height: number;
  bytes: number;
  mime: string;
  durationSec: number;
  framesDone: number;
  fps: number;
  hasAudio: boolean;
  /** Plain-language note when audio was dropped or could not be copied. */
  audioNote: string | null;
  elapsedMs: number;
}

export interface ImageDoneInfo {
  width: number;
  height: number;
  bytes: number;
  mime: string;
  passes: number;
  elapsedMs: number;
}

export type WorkerToMain =
  | { type: 'boot' }
  | { type: 'stage'; jobId: string; stage: Stage; detail?: string }
  | {
      type: 'progress';
      jobId: string;
      /** 0..1, from real measurements only. */
      ratio: number;
      elapsedMs: number;
      /** Video jobs */
      framesDone?: number;
      framesTotal?: number | null;
      framesTotalExact?: boolean;
      fps?: number;
      /** Image jobs */
      step?: number;
      steps?: number;
    }
  | { type: 'preview'; jobId: string; bitmap: ImageBitmap }
  | { type: 'video-done'; jobId: string; blob: Blob; info: VideoDoneInfo }
  | { type: 'image-done'; jobId: string; blob: Blob; info: ImageDoneInfo }
  | { type: 'error'; jobId: string; code: ErrorCode; message: string; hint?: string };
