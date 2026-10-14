/**
 * Processing worker. All heavy work (decode, neural network, encode, mux) happens here so the
 * page stays responsive. One job at a time; cancelling a job terminates the whole worker,
 * which releases the decoder, encoder and GPU device immediately.
 */
import type { MainToWorker, WorkerToMain } from './protocol';
import { runVideoJob } from './video-job';
import { runImageJob } from './image-job';
import { toJobError } from '../lib/errors';

const scope = self as unknown as {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent<MainToWorker>) => void) | null;
};

let busy = false;

function post(message: WorkerToMain, transfer: Transferable[] = []): void {
  scope.postMessage(message, transfer);
}

scope.onmessage = async (event) => {
  const req = event.data;
  if (!req || typeof req !== 'object' || !('type' in req)) return;

  if (busy) {
    post({ type: 'error', jobId: req.jobId, code: 'invalid-input', message: 'A job is already running.' });
    return;
  }
  busy = true;
  try {
    if (req.type === 'video') await runVideoJob(req, post);
    else if (req.type === 'image') await runImageJob(req, post);
  } catch (e) {
    const err = toJobError(e);
    console.error('[zafronix worker]', e);
    post({ type: 'error', jobId: req.jobId, code: err.code, message: err.message, hint: err.hint });
  } finally {
    busy = false;
  }
};

post({ type: 'boot' });
