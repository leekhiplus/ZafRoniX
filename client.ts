/**
 * Page-side handle for the processing worker.
 *
 * - one job at a time (a second start() while busy is refused)
 * - cancel() terminates the worker, which frees everything it holds, then boots a fresh one
 * - every message is tagged with a job id so stale messages from a cancelled job are ignored
 */
import type { MainToWorker, WorkerToMain } from './protocol';
import { spawnWorker } from './spawn';

export type JobEvents = (message: WorkerToMain) => void;

export class WorkerClient {
  private worker: Worker | null = null;
  private activeJob: string | null = null;
  private listener: JobEvents | null = null;

  get busy(): boolean {
    return this.activeJob !== null;
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = spawnWorker();
    worker.onmessage = (event: MessageEvent<WorkerToMain>) => this.handle(event.data);
    // A worker-level error means the worker is unusable: report it, then discard the worker.
    const crash = (message: string, hint?: string) => {
      const jobId = this.activeJob;
      const listener = this.listener;
      this.cancel();
      if (jobId) listener?.({ type: 'error', jobId, code: 'unknown', message, hint });
    };
    worker.onerror = (event) =>
      crash(
        event.message || 'The processing worker crashed.',
        'Reload the page and try again. If it keeps happening, try a smaller file.',
      );
    worker.onmessageerror = () => crash('A message from the worker could not be read.');
    this.worker = worker;
    return worker;
  }

  private handle(message: WorkerToMain): void {
    if (message.type === 'boot') return;
    if (message.jobId !== this.activeJob) return; // stale message from a cancelled job
    if (message.type === 'video-done' || message.type === 'image-done' || message.type === 'error') {
      this.finish();
      // keep a reference so the listener can still be called after finish()
      this.dispatch(message);
      return;
    }
    this.dispatch(message);
  }

  private dispatch(message: WorkerToMain): void {
    this.listener?.(message);
  }

  private finish(): void {
    this.activeJob = null;
  }

  /** Starts a job. Returns false if another job is still running. */
  start(request: MainToWorker, listener: JobEvents, transfer: Transferable[] = []): boolean {
    if (this.activeJob) return false;
    this.activeJob = request.jobId;
    this.listener = listener;
    this.ensureWorker().postMessage(request, transfer);
    return true;
  }

  /** Stops the current job immediately and discards the worker with everything it holds. */
  cancel(): void {
    this.activeJob = null;
    this.listener = null;
    if (this.worker) {
      this.worker.onmessage = null;
      this.worker.onerror = null;
      this.worker.terminate();
      this.worker = null;
    }
  }

  dispose(): void {
    this.cancel();
  }
}
