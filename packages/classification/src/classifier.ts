import { usableThumbnail, type ClassificationInput, type InputsUsed } from './input.ts';
import { validateClassification, type ClassificationResult } from './schema.ts';

export type ClassifierErrorKind =
  | 'unconfigured' // no provider/credentials
  | 'invalid_output' // output failed schema/product validation — quarantined, not stored
  | 'refused' // the model declined
  | 'truncated' // output hit the token limit
  | 'rate_limited'
  | 'provider_error'; // network, 5xx, auth, bad request

export class ClassifierError extends Error {
  readonly kind: ClassifierErrorKind;
  readonly retryable: boolean;
  readonly details: string[];
  constructor(
    kind: ClassifierErrorKind,
    message: string,
    options: { retryable?: boolean; details?: string[]; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? {} : { cause: options.cause });
    this.name = 'ClassifierError';
    this.kind = kind;
    this.retryable = options.retryable ?? false;
    this.details = options.details ?? [];
  }
}

export interface ClassifierOutput {
  result: ClassificationResult;
  inputsUsed: InputsUsed;
  provider: string;
  /** The model that actually produced the output (may differ from the requested one on fallback). */
  model: string;
}

/** The provider-neutral contract. Implementations must never fabricate output. */
export interface ContentClassifier {
  readonly provider: string;
  readonly model: string;
  classify(
    input: ClassificationInput,
    options?: { signal?: AbortSignal },
  ): Promise<ClassifierOutput>;
}

/** A provider's raw answer; the shared layer validates it. */
export interface TransportResponse {
  output: unknown;
  model: string;
  stop: 'complete' | 'refusal' | 'truncated';
}

/**
 * Thrown by a transport when the request failed *because of the image*
 * (e.g. the provider could not fetch the thumbnail). The shared layer retries text-only.
 */
export class ThumbnailRejectedError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ThumbnailRejectedError';
  }
}

export type Transport = (
  input: ClassificationInput,
  thumbnailUrl: string | null,
  signal: AbortSignal | undefined,
) => Promise<TransportResponse>;

/**
 * Shared behavior for every provider: thumbnail → text-only fallback, refusal and
 * truncation handling, and Zod validation (invalid output is an error, never stored).
 */
export function classifierFromTransport(
  provider: string,
  model: string,
  transport: Transport,
): ContentClassifier {
  return {
    provider,
    model,
    async classify(input, options = {}) {
      const thumbnail = usableThumbnail(input.thumbnailUrl);
      let response: TransportResponse;
      let thumbnailState: InputsUsed['thumbnail'] = thumbnail ? 'used' : 'none';
      let thumbnailNote: string | undefined =
        input.thumbnailUrl && !thumbnail ? 'not an https URL' : undefined;
      try {
        response = await transport(input, thumbnail, options.signal);
      } catch (err) {
        if (!(err instanceof ThumbnailRejectedError) || !thumbnail) throw err;
        thumbnailState = 'unavailable';
        thumbnailNote = err.message;
        response = await transport(input, null, options.signal);
      }
      if (response.stop === 'refusal') {
        throw new ClassifierError('refused', `${provider} declined to classify this candidate`);
      }
      if (response.stop === 'truncated') {
        throw new ClassifierError('truncated', `${provider} output was truncated`, {
          retryable: true,
        });
      }
      const validated = validateClassification(response.output);
      if (!validated.ok) {
        throw new ClassifierError('invalid_output', 'classifier output failed validation', {
          details: validated.errors,
        });
      }
      return {
        result: validated.value,
        provider,
        model: response.model,
        inputsUsed: {
          title: input.title !== null,
          caption: input.caption !== null,
          creator: input.creator !== null,
          duration: input.durationMs !== null,
          discoveryContext: input.discoveryContext.length,
          thumbnail: thumbnailState,
          ...(thumbnailNote ? { thumbnailNote } : {}),
        },
      };
    },
  };
}
