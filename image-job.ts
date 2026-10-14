/**
 * Image upscaling (runs inside the worker).
 *
 * The network doubles the size of its input. A 4x result is produced by running the 2x network
 * twice, one pass after the other: this is stated in the interface and in the README rather than
 * presented as a separate 4x model.
 *
 * Each pass uses its own GPU device which is destroyed right afterwards, so the large
 * intermediate textures of one pass are freed before the next pass starts.
 */
import WebSR from '@websr/websr';

import type { ImageJobRequest, WorkerToMain } from './protocol';
import { NETWORK_NAME, loadWeights } from './models';
import { acquireGpu } from './gpu';
import { JobError } from '../lib/errors';
import { planImageOutput } from '../lib/planning';

type Post = (msg: WorkerToMain, transfer?: Transferable[]) => void;

const MIME = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' } as const;

/**
 * Runs one 2x pass. Returns an ImageBitmap for intermediate passes, or an encoded Blob when
 * `encode` is given (the encode happens before the GPU device is destroyed).
 */
async function enhanceOnce(
  input: ImageBitmap,
  req: ImageJobRequest,
  weights: unknown,
  encode: { type: string; quality: number } | null,
): Promise<ImageBitmap | Blob> {
  const w = input.width;
  const h = input.height;
  const gpu = await acquireGpu();
  try {
    const gpuCanvas = new OffscreenCanvas(w * 2, h * 2);
    const websr: any = new WebSR({
      network_name: NETWORK_NAME[req.model.size],
      weights,
      resolution: { width: w, height: h },
      gpu: gpu.device,
      canvas: gpuCanvas as any,
    } as any);

    await websr.render(input);
    gpu.assertAlive();

    // Copy the result out of the GPU canvas into an ordinary 2D canvas straight away.
    const out = new OffscreenCanvas(w * 2, h * 2);
    const ctx = out.getContext('2d', { alpha: false });
    if (!ctx) throw new JobError('unknown', 'Could not create the output surface.');
    ctx.drawImage(gpuCanvas, 0, 0);

    if (encode) {
      return await out.convertToBlob({ type: encode.type, quality: encode.quality });
    }
    return out.transferToImageBitmap();
  } finally {
    gpu.destroy();
  }
}

export async function runImageJob(req: ImageJobRequest, post: Post): Promise<void> {
  const t0 = performance.now();
  const { jobId } = req;

  post({ type: 'stage', jobId, stage: 'analyzing' });

  let source: ImageBitmap;
  try {
    source = await createImageBitmap(req.file);
  } catch {
    throw new JobError('decode-failed', 'This image could not be read.', 'The file may be damaged. Try saving it again as PNG or JPEG.');
  }

  const planned = planImageOutput(source.width, source.height, req.scale);
  if (!planned.ok) {
    source.close();
    throw new JobError('invalid-input', planned.reason);
  }
  const plan = planned.plan;
  const steps = 1 + plan.passes + 1; // load model, each pass, encode
  let step = 0;
  const progress = () =>
    post({ type: 'progress', jobId, ratio: step / steps, elapsedMs: performance.now() - t0, step, steps });

  post({ type: 'stage', jobId, stage: 'loading-model' });
  progress();
  const weights = await loadWeights(req.baseUrl, req.model);
  step = 1;
  progress();

  post({ type: 'stage', jobId, stage: 'enhancing', detail: plan.passes === 2 ? 'Pass 1 of 2' : undefined });

  let current: ImageBitmap = source;
  let blob: Blob | null = null;
  const encodeOptions = { type: MIME[req.format], quality: req.quality };

  try {
    for (let pass = 1; pass <= plan.passes; pass++) {
      if (pass > 1) post({ type: 'stage', jobId, stage: 'enhancing', detail: `Pass ${pass} of ${plan.passes}` });
      const last = pass === plan.passes;
      const result = await enhanceOnce(current, req, weights, last ? encodeOptions : null);
      current.close();
      if (result instanceof Blob) {
        blob = result;
      } else {
        current = result;
      }
      step++;
      progress();
    }
  } catch (e) {
    try {
      current.close();
    } catch {
      /* already closed */
    }
    throw e;
  }

  if (!blob) throw new JobError('encode-failed', 'The enhanced image could not be saved.');

  post({ type: 'stage', jobId, stage: 'finalizing' });
  step = steps;
  progress();

  post({
    type: 'image-done',
    jobId,
    blob,
    info: {
      width: plan.outW,
      height: plan.outH,
      bytes: blob.size,
      mime: blob.type || encodeOptions.type,
      passes: plan.passes,
      elapsedMs: performance.now() - t0,
    },
  });
}
