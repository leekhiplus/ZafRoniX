/**
 * GPU access for the worker. WebSR owns the neural network; this module only acquires the
 * WebGPU device, watches for device loss, and releases the device deterministically.
 */
import WebSR from '@websr/websr';
import { JobError } from '../lib/errors';

export interface GpuHandle {
  /** The raw GPUDevice handed to WebSR. */
  device: any;
  /** Throws a JobError if the device was lost. Call between GPU operations. */
  assertAlive(): void;
  /** Destroys the device and frees every GPU resource created from it. */
  destroy(): void;
}

export async function acquireGpu(): Promise<GpuHandle> {
  let device: any;
  try {
    device = await WebSR.initWebGPU();
  } catch {
    device = false;
  }
  if (!device) {
    throw new JobError(
      'webgpu-unavailable',
      'WebGPU is not available in this browser, so the AI model cannot run.',
      'Use the latest desktop Chrome or Edge, and make sure hardware acceleration is turned on.',
    );
  }

  let lostReason: string | null = null;
  let destroyedByUs = false;

  const lost: Promise<{ reason?: string; message?: string }> | undefined = device.lost;
  lost?.then((info) => {
    if (!destroyedByUs) lostReason = info?.message || info?.reason || 'unknown reason';
  });

  return {
    device,
    assertAlive() {
      if (lostReason) {
        throw new JobError(
          'gpu-lost',
          `The graphics device was lost (${lostReason}).`,
          'Reload the page and try again. A smaller file or the Small model puts less load on the GPU.',
        );
      }
    },
    destroy() {
      destroyedByUs = true;
      try {
        device.destroy?.();
      } catch {
        /* already gone */
      }
    },
  };
}
