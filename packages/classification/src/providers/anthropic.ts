import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import {
  ClassifierError,
  ThumbnailRejectedError,
  classifierFromTransport,
  type ContentClassifier,
} from '../classifier.ts';
import { candidateText, SYSTEM_PROMPT } from '../prompt.ts';
import { ModelOutputSchema } from '../schema.ts';

export const ANTHROPIC_DEFAULT_MODEL = 'claude-opus-5-5';

/** JSON-schema output format derived from the Zod schema (bounds validated client-side). */
const { type: formatType, schema: formatSchema } = betaZodOutputFormat(ModelOutputSchema);
const OUTPUT_FORMAT = { type: formatType, schema: formatSchema };

export interface AnthropicClassifierOptions {
  apiKey: string;
  model?: string;
  /** Classification is a short, well-specified task; low effort keeps cost down. */
  effort?: 'low' | 'medium' | 'high';
  /** Injected in tests. */
  client?: Anthropic;
}

/**
 * Claude via the Messages API with structured output (schema-constrained JSON,
 * validated again client-side). Server-side refusal fallbacks are enabled
 * ("default" routing); the model that actually answered is recorded.
 */
export function createAnthropicClassifier(options: AnthropicClassifierOptions): ContentClassifier {
  const model = options.model ?? ANTHROPIC_DEFAULT_MODEL;
  const client = options.client ?? new Anthropic({ apiKey: options.apiKey, maxRetries: 2 });

  return classifierFromTransport('anthropic', model, async (input, thumbnailUrl, signal) => {
    const content: Anthropic.Beta.BetaContentBlockParam[] = [];
    if (thumbnailUrl) content.push({ type: 'image', source: { type: 'url', url: thumbnailUrl } });
    content.push({ type: 'text', text: candidateText(input, thumbnailUrl !== null) });
    try {
      // messages.create (not .parse) so stop_reason is checked before any parsing:
      // a refusal or truncation carries no valid JSON. The schema still constrains
      // generation; the shared layer validates the parsed JSON with Zod.
      const response = await client.beta.messages.create(
        {
          model,
          max_tokens: 4_000,
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
          system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
          output_config: { format: OUTPUT_FORMAT, effort: options.effort ?? 'low' },
          messages: [{ role: 'user', content }],
        },
        signal ? { signal } : {},
      );
      if (response.stop_reason === 'refusal')
        return { output: null, model: response.model, stop: 'refusal' };
      if (response.stop_reason === 'max_tokens')
        return { output: null, model: response.model, stop: 'truncated' };
      const text = response.content
        .flatMap((block) => (block.type === 'text' ? [block.text] : []))
        .join('');
      let output: unknown;
      try {
        output = JSON.parse(text);
      } catch {
        output = text; // fails validation → quarantined as invalid output
      }
      return { output, model: response.model, stop: 'complete' };
    } catch (err) {
      // A 400 while an image was attached is most often an unfetchable thumbnail URL;
      // the shared layer retries once without it (a genuine request problem fails again).
      if (thumbnailUrl && err instanceof Anthropic.BadRequestError) {
        throw new ThumbnailRejectedError('provider could not use the thumbnail URL', {
          cause: err,
        });
      }
      if (err instanceof Anthropic.RateLimitError) {
        throw new ClassifierError('rate_limited', 'anthropic rate limit', {
          retryable: true,
          cause: err,
        });
      }
      if (
        err instanceof Anthropic.AuthenticationError ||
        err instanceof Anthropic.PermissionDeniedError
      ) {
        throw new ClassifierError('provider_error', 'anthropic rejected the API key', {
          cause: err,
        });
      }
      if (
        err instanceof Anthropic.InternalServerError ||
        err instanceof Anthropic.APIConnectionError
      ) {
        throw new ClassifierError('provider_error', 'anthropic unavailable', {
          retryable: true,
          cause: err,
        });
      }
      if (err instanceof Anthropic.APIError) {
        throw new ClassifierError('provider_error', `anthropic error ${String(err.status)}`, {
          cause: err,
        });
      }
      throw err;
    }
  });
}
