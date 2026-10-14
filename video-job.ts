/**
 * Video upscaling pipeline (runs inside the worker).
 *
 *   File -> web-demuxer (compressed chunks)
 *        -> WebCodecs VideoDecoder
 *        -> WebSR neural network on the GPU (2x)
 *        -> optional resize to the 1080p cap
 *        -> WebCodecs VideoEncoder (H.264)
 *        -> mediabunny MP4 muxer -> in-memory file
 *
 * Audio is copied as compressed packets (no re-encode), so quality is untouched.
 *
 * Adapted from the reference project's pipeline-processor (MIT, (c) 2026 Sam Bhattacharyya):
 * same demux/decode/upscale/encode architecture, with added capability checks, frame-size
 * validation, audio-codec checks, a real 1080p fit step, preview frames and honest errors.
 */
import { WebDemuxer } from 'web-demuxer';
import {
  Output,
  Mp4OutputFormat,
  StreamTarget,
  EncodedVideoPacketSource,
  EncodedAudioPacketSource,
  EncodedPacket,
} from 'mediabunny';
import WebSR from '@websr/websr';

import type { VideoJobRequest, WorkerToMain } from './protocol';
import { NETWORK_NAME, loadWeights } from './models';
import { acquireGpu } from './gpu';
import InMemoryStorage from './in-memory-storage';
import { JobError } from '../lib/errors';
import { keyframeInterval, videoBitrate } from '../lib/planning';

type Post = (msg: WorkerToMain, transfer?: Transferable[]) => void;

/**
 * The demuxer WASM is served from our own origin (copied at build time). The CDN URLs are a
 * last resort, used only if the local copy is missing: first the pinned version, then the URL
 * the reference project uses.
 */
const WASM_CDN_FALLBACKS = [
  'https://cdn.jsdelivr.net/npm/web-demuxer@4.0.0/dist/wasm-files/web-demuxer.wasm',
  'https://cdn.jsdelivr.net/npm/web-demuxer@latest/dist/wasm-files/web-demuxer.wasm',
];

/** H.264 profiles/levels to try, in order. */
const AVC_CODECS = ['avc1.4d0034', 'avc1.640034', 'avc1.4d0028'];

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function resolveWasmUrl(baseUrl: string): Promise<string> {
  const candidates = [new URL('wasm/web-demuxer.wasm', baseUrl).href, ...WASM_CDN_FALLBACKS];
  for (const url of candidates) {
    try {
      const res = await fetch(url, { method: 'HEAD' });
      const type = res.headers.get('content-type') ?? '';
      if (res.ok && !type.includes('text/html')) return url;
    } catch {
      /* try the next candidate */
    }
  }
  return candidates[0];
}

function parseRate(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const [n, d] = value.split('/').map(Number);
  if (!n || !d) return null;
  const fps = n / d;
  return fps >= 1 && fps <= 240 ? fps : null;
}

/** Maps a WebCodecs audio codec string to the codec name the MP4 muxer expects. */
function muxerAudioCodec(codec: string): 'aac' | 'mp3' | 'opus' | null {
  const c = codec.toLowerCase();
  if (c.startsWith('mp4a.40')) return 'aac';
  if (c === 'mp3' || c === 'mp4a.6b' || c === 'mp4a.69') return 'mp3';
  if (c === 'opus') return 'opus';
  return null;
}

async function pickEncoderConfig(width: number, height: number, fps: number, bitrate: number): Promise<VideoEncoderConfig> {
  if (typeof VideoEncoder === 'undefined') {
    throw new JobError('encoder-unsupported', 'This browser has no video encoder (WebCodecs).', 'Use the latest desktop Chrome or Edge.');
  }
  for (const codec of AVC_CODECS) {
    const config: VideoEncoderConfig = { codec, width, height, bitrate, framerate: fps };
    try {
      const support = await VideoEncoder.isConfigSupported(config);
      if (support.supported) return config;
    } catch {
      /* try next */
    }
  }
  throw new JobError(
    'encoder-unsupported',
    `This browser cannot encode H.264 video at ${width}×${height}.`,
    'Use the latest desktop Chrome or Edge. Chromium builds without proprietary codecs cannot encode H.264.',
  );
}

export async function runVideoJob(req: VideoJobRequest, post: Post): Promise<void> {
  const t0 = performance.now();
  const { jobId } = req;
  const cleanups: Array<() => void> = [];
  const track = (fn: () => void) => cleanups.push(fn);
  const runCleanups = () => {
    while (cleanups.length) {
      try {
        cleanups.pop()!();
      } catch {
        /* best effort */
      }
    }
  };

  try {
    // ---------------------------------------------------------------- analyze
    post({ type: 'stage', jobId, stage: 'analyzing' });

    const demuxer: any = new WebDemuxer({ wasmFilePath: await resolveWasmUrl(req.baseUrl) });
    track(() => demuxer.destroy?.());
    await demuxer.load(req.file);

    const info = await demuxer.getMediaInfo();
    const streams: any[] = info?.streams ?? [];
    const vStream = streams.find((s) => s.codec_type_string === 'video');
    const aStream = streams.find((s) => s.codec_type_string === 'audio');
    if (!vStream) throw new JobError('no-video-track', 'No video track was found in this file.');

    // Phone videos often carry a rotation flag instead of rotated pixels. The preview element
    // reports the displayed size, the demuxer reports the stored size; if the orientation
    // differs, the video is rotated and would come out sideways.
    const storedW = Number(vStream.width) || 0;
    const storedH = Number(vStream.height) || 0;
    if (storedW && storedH && storedW !== storedH && storedW > storedH !== req.srcW > req.srcH) {
      throw new JobError(
        'rotation-unsupported',
        'This video uses rotation metadata (typical for phone recordings), which is not supported yet.',
        'Re-export it with the rotation applied, then try again.',
      );
    }

    const decoderConfig = (await demuxer.getDecoderConfig('video')) as VideoDecoderConfig;
    if (typeof VideoDecoder === 'undefined') {
      throw new JobError('codec-unsupported', 'This browser has no video decoder (WebCodecs).', 'Use the latest desktop Chrome or Edge.');
    }
    const decodeSupport = await VideoDecoder.isConfigSupported(decoderConfig);
    if (!decodeSupport.supported) {
      throw new JobError(
        'codec-unsupported',
        `This browser cannot decode this video's codec (${decoderConfig.codec}).`,
        'Convert the video to H.264 (MP4) and try again.',
      );
    }

    const fps = parseRate(vStream.avg_frame_rate) ?? parseRate(vStream.r_frame_rate) ?? 30;
    const duration = Number(vStream.duration) || Number(info?.duration) || req.durationHint || 0;
    const declaredFrames = Number(vStream.nb_frames) || 0;
    const framesTotal = declaredFrames > 0 ? declaredFrames : duration > 0 ? Math.round(duration * fps) : null;
    const framesTotalExact = declaredFrames > 0;

    const encoderConfig = await pickEncoderConfig(req.outW, req.outH, fps, videoBitrate(req.outW, req.outH, fps, req.quality));

    // ---------------------------------------------------------------- load model + GPU
    post({ type: 'stage', jobId, stage: 'loading-model' });
    const weights = await loadWeights(req.baseUrl, req.model);
    const gpu = await acquireGpu();
    track(() => gpu.destroy());

    const aiCanvas = new OffscreenCanvas(req.srcW * 2, req.srcH * 2);
    const websr: any = new WebSR({
      network_name: NETWORK_NAME[req.model.size],
      weights,
      resolution: { width: req.srcW, height: req.srcH },
      gpu: gpu.device,
      canvas: aiCanvas as any,
    } as any);

    const needsFit = req.outW !== req.srcW * 2 || req.outH !== req.srcH * 2;
    let fitCanvas: OffscreenCanvas | null = null;
    let fitCtx: OffscreenCanvasRenderingContext2D | null = null;
    if (needsFit) {
      fitCanvas = new OffscreenCanvas(req.outW, req.outH);
      fitCtx = fitCanvas.getContext('2d', { alpha: false });
      if (!fitCtx) throw new JobError('unknown', 'Could not create the resize surface.');
      fitCtx.imageSmoothingEnabled = true;
      fitCtx.imageSmoothingQuality = 'high';
    }

    // ---------------------------------------------------------------- output container
    const storage = new InMemoryStorage();
    const output = new Output({
      format: new Mp4OutputFormat(),
      target: new StreamTarget(
        new WritableStream({
          write(chunk: { data: Uint8Array; position: number }) {
            storage.write(chunk.data, chunk.position);
          },
        }),
      ),
    });

    const videoSource = new EncodedVideoPacketSource('avc');
    output.addVideoTrack(videoSource);

    let audioSource: EncodedAudioPacketSource | null = null;
    let audioConfig: AudioDecoderConfig | null = null;
    let audioNote: string | null = null;
    if (aStream && req.keepAudio) {
      audioConfig = (await demuxer.getDecoderConfig('audio')) as AudioDecoderConfig;
      const codec = muxerAudioCodec(audioConfig.codec);
      if (codec) {
        audioSource = new EncodedAudioPacketSource(codec);
        output.addAudioTrack(audioSource);
      } else {
        audioConfig = null;
        audioNote = `The original audio (${(aStream.codec_name as string) || 'unknown codec'}) cannot be copied into an MP4, so the result has no sound.`;
      }
    } else if (aStream && !req.keepAudio) {
      audioNote = 'Audio was removed, as requested.';
    }

    // ---------------------------------------------------------------- pipeline stages
    let framesDone = 0;
    let ratio = 0;
    let lastProgressPost = 0;
    let lastPreviewPost = 0;

    const postProgress = (force = false) => {
      const now = performance.now();
      if (!force && now - lastProgressPost < 200) return;
      lastProgressPost = now;
      const elapsedMs = now - t0;
      post({
        type: 'progress',
        jobId,
        ratio: Math.min(ratio, 0.999),
        elapsedMs,
        framesDone,
        framesTotal,
        framesTotalExact,
        fps: elapsedMs > 0 ? framesDone / (elapsedMs / 1000) : 0,
      });
    };

    const decodeStream = new TransformStream<EncodedVideoChunk, VideoFrame>(
      (() => {
        let decoder: VideoDecoder;
        return {
          start(controller) {
            decoder = new VideoDecoder({
              output: (frame) => controller.enqueue(frame),
              error: (e) => controller.error(e),
            });
            decoder.configure(decoderConfig);
            track(() => {
              if (decoder.state !== 'closed') decoder.close();
            });
          },
          async transform(chunk, controller) {
            while (decoder.decodeQueueSize >= 16 || (controller.desiredSize !== null && controller.desiredSize <= 0)) {
              if (decoder.state === 'closed') return;
              await sleep(4);
            }
            decoder.decode(chunk);
          },
          async flush() {
            await decoder.flush();
            if (decoder.state !== 'closed') decoder.close();
          },
        } as Transformer<EncodedVideoChunk, VideoFrame>;
      })(),
      undefined,
      { highWaterMark: 3 },
    );

    const upscaleStream = new TransformStream<VideoFrame, VideoFrame>(
      {
        async transform(frame, controller) {
          try {
            if (frame.displayWidth !== req.srcW || frame.displayHeight !== req.srcH) {
              throw new JobError(
                'size-mismatch',
                `A frame had an unexpected size (${frame.displayWidth}×${frame.displayHeight}, expected ${req.srcW}×${req.srcH}).`,
                'Videos whose resolution changes during playback are not supported.',
              );
            }
            await websr.render(frame);
            gpu.assertAlive();

            let source: OffscreenCanvas = aiCanvas;
            if (fitCtx && fitCanvas) {
              fitCtx.drawImage(aiCanvas, 0, 0, req.outW, req.outH);
              source = fitCanvas;
            }

            const init: VideoFrameInit = { timestamp: frame.timestamp, alpha: 'discard' };
            if (frame.duration != null) init.duration = frame.duration;
            const out = new VideoFrame(source, init);

            // Live preview: a small copy of a real enhanced frame, a couple of times per second.
            const now = performance.now();
            if (now - lastPreviewPost > 500) {
              lastPreviewPost = now;
              const copy = out.clone();
              createImageBitmap(copy, { resizeWidth: 640, resizeQuality: 'low' })
                .then((bitmap) => post({ type: 'preview', jobId, bitmap }, [bitmap]))
                .catch(() => undefined)
                .finally(() => copy.close());
            }

            controller.enqueue(out);
          } finally {
            frame.close();
          }
        },
      },
      { highWaterMark: 2 },
      { highWaterMark: 2 },
    );

    const kfInterval = keyframeInterval(fps);
    const encodeStream = new TransformStream<VideoFrame, { chunk: EncodedVideoChunk; meta?: EncodedVideoChunkMetadata }>(
      (() => {
        let encoder: VideoEncoder;
        let n = 0;
        return {
          start(controller) {
            encoder = new VideoEncoder({
              output: (chunk, meta) => controller.enqueue({ chunk, meta }),
              error: (e) => controller.error(e),
            });
            encoder.configure(encoderConfig);
            track(() => {
              if (encoder.state !== 'closed') encoder.close();
            });
          },
          async transform(frame) {
            try {
              while (encoder.encodeQueueSize >= 12) {
                if (encoder.state === 'closed') return;
                await sleep(4);
              }
              encoder.encode(frame, { keyFrame: n++ % kfInterval === 0 });
            } finally {
              frame.close();
            }
          },
          async flush() {
            await encoder.flush();
            if (encoder.state !== 'closed') encoder.close();
          },
        } as Transformer<VideoFrame, { chunk: EncodedVideoChunk; meta?: EncodedVideoChunkMetadata }>;
      })(),
      undefined,
      { highWaterMark: 4 },
    );

    const videoSink = new WritableStream<{ chunk: EncodedVideoChunk; meta?: EncodedVideoChunkMetadata }>({
      async write({ chunk, meta }) {
        await videoSource.add(EncodedPacket.fromEncodedChunk(chunk), meta as any);
        framesDone++;
        if (duration > 0) ratio = Math.max(ratio, chunk.timestamp / 1e6 / duration);
        else if (framesTotal) ratio = Math.max(ratio, framesDone / framesTotal);
        postProgress();
      },
    });

    // ---------------------------------------------------------------- run
    post({ type: 'stage', jobId, stage: 'enhancing' });
    await output.start();

    const videoPipeline = (demuxer.read('video', 0) as ReadableStream<EncodedVideoChunk>)
      .pipeThrough(decodeStream)
      .pipeThrough(upscaleStream)
      .pipeThrough(encodeStream)
      .pipeTo(videoSink);

    // Audio is added concurrently so the muxer can interleave and write as it goes.
    const audioPipeline =
      audioSource && audioConfig
        ? (() => {
            let first = true;
            const cfg = audioConfig;
            const src = audioSource;
            return (demuxer.read('audio', 0) as ReadableStream<EncodedAudioChunk>).pipeTo(
              new WritableStream<EncodedAudioChunk>({
                async write(chunk) {
                  if (chunk.timestamp < 0) return;
                  const meta = first ? { decoderConfig: cfg } : undefined;
                  first = false;
                  await src.add(EncodedPacket.fromEncodedChunk(chunk), meta as any);
                },
              }),
            );
          })()
        : Promise.resolve();

    await Promise.all([videoPipeline, audioPipeline]);

    if (framesDone === 0) {
      throw new JobError('decode-failed', 'No video frames could be decoded from this file.', 'The file may be damaged or use an unsupported codec.');
    }

    // ---------------------------------------------------------------- finalize
    post({ type: 'stage', jobId, stage: 'finalizing' });
    postProgress(true);
    await output.finalize();

    const blob = storage.toBlob('video/mp4');
    const bytes = storage.size;
    storage.clear();

    const elapsedMs = performance.now() - t0;
    post({
      type: 'video-done',
      jobId,
      blob,
      info: {
        width: req.outW,
        height: req.outH,
        bytes,
        mime: 'video/mp4',
        durationSec: duration,
        framesDone,
        fps,
        hasAudio: Boolean(audioSource),
        audioNote,
        elapsedMs,
      },
    });
  } finally {
    runCleanups();
  }
}
