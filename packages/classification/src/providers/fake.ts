import {
  ThumbnailRejectedError,
  classifierFromTransport,
  type ContentClassifier,
  type TransportResponse,
} from '../classifier.ts';
import type { ClassificationInput } from '../input.ts';

export interface FakeClassifierOptions {
  model?: string;
  /** Produce the raw "model output" for an input; throw to simulate provider errors. */
  respond: (input: ClassificationInput, thumbnailUrl: string | null) => unknown;
  /** Simulate a provider that cannot fetch thumbnails. */
  rejectThumbnails?: boolean;
  stop?: TransportResponse['stop'];
}

/**
 * Deterministic provider for tests and local development. It goes through the
 * same shared validation/fallback layer as real providers.
 */
export function createFakeClassifier(
  options: FakeClassifierOptions,
): ContentClassifier & { calls: { thumbnailUrl: string | null }[] } {
  const calls: { thumbnailUrl: string | null }[] = [];
  const model = options.model ?? 'fake-classifier-1';
  const classifier = classifierFromTransport('fake', model, (input, thumbnailUrl) => {
    calls.push({ thumbnailUrl });
    if (thumbnailUrl && options.rejectThumbnails) {
      return Promise.reject(new ThumbnailRejectedError('thumbnail could not be fetched'));
    }
    try {
      return Promise.resolve({
        output: options.respond(input, thumbnailUrl),
        model,
        stop: options.stop ?? 'complete',
      });
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
  return Object.assign(classifier, { calls });
}
