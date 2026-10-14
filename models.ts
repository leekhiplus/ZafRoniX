/**
 * Model catalogue. Every entry maps to a weight file that actually ships in /public/weights.
 * Nothing is listed here that the engine cannot load.
 */
import type { ModelChoice, ModelSize } from './protocol';
import { JobError } from '../lib/errors';

/** Network identifiers understood by WebSR (Anime4K CNN family, 2x). */
export const NETWORK_NAME: Record<ModelSize, string> = {
  small: 'anime4k/cnn-2x-s',
  medium: 'anime4k/cnn-2x-m',
  large: 'anime4k/cnn-2x-l',
};

const SIZE_LETTER: Record<ModelSize, string> = { small: 's', medium: 'm', large: 'l' };

export function weightsFileName(model: ModelChoice): string {
  return `cnn-2x-${SIZE_LETTER[model.size]}-${model.content}.json`;
}

const cache = new Map<string, unknown>();

/** Fetches the weights for a model once per worker session. */
export async function loadWeights(baseUrl: string, model: ModelChoice): Promise<unknown> {
  const file = weightsFileName(model);
  const hit = cache.get(file);
  if (hit) return hit;

  const url = new URL(`weights/${file}`, baseUrl).href;
  let res: Response;
  try {
    res = await fetch(url);
  } catch {
    throw new JobError('model-load-failed', 'The AI model could not be downloaded.', 'Check your connection and try again.');
  }
  if (!res.ok) {
    throw new JobError('model-load-failed', `The AI model file was not found (${res.status}).`, 'Reload the page and try again.');
  }
  const json = await res.json();
  cache.set(file, json);
  return json;
}
