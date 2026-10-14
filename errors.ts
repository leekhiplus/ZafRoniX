/**
 * Error model shared by the worker and the UI. No imports.
 * Every failure that reaches the user has a code, a plain-language message and, when
 * possible, a hint about what to try next.
 */

export type ErrorCode =
  | 'webgpu-unavailable'
  | 'gpu-lost'
  | 'model-load-failed'
  | 'codec-unsupported'
  | 'encoder-unsupported'
  | 'rotation-unsupported'
  | 'size-mismatch'
  | 'no-video-track'
  | 'decode-failed'
  | 'encode-failed'
  | 'out-of-memory'
  | 'invalid-input'
  | 'unknown';

export class JobError extends Error {
  readonly code: ErrorCode;
  readonly hint?: string;

  constructor(code: ErrorCode, message: string, hint?: string) {
    super(message);
    this.name = 'JobError';
    this.code = code;
    this.hint = hint;
  }
}

/** Converts anything that was thrown into a JobError with a useful message. */
export function toJobError(e: unknown): JobError {
  if (e instanceof JobError) return e;

  const name = (e as { name?: string } | null)?.name ?? '';
  const raw = e instanceof Error ? e.message : typeof e === 'string' ? e : '';
  const text = `${name} ${raw}`;

  if (/out of memory|allocation failed|array buffer allocation|quota/i.test(text)) {
    return new JobError(
      'out-of-memory',
      'The browser ran out of memory.',
      'Try a shorter or smaller file, close other tabs, or use the 2x option for images.',
    );
  }
  if (/device.*lost|lost.*device|GPUDevice|context lost/i.test(text)) {
    return new JobError(
      'gpu-lost',
      'The graphics device stopped responding.',
      'Reload the page and try again. A smaller file or the Small model puts less load on the GPU.',
    );
  }
  if (name === 'NotSupportedError') {
    return new JobError('codec-unsupported', raw || 'This browser does not support the required codec.');
  }
  if (name === 'EncodingError' || name === 'OperationError') {
    return new JobError('encode-failed', raw || 'The video could not be encoded.');
  }
  return new JobError('unknown', raw || 'Something went wrong while processing.');
}
