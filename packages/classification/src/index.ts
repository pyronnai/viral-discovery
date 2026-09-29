export * from './taxonomy.ts';
export * from './schema.ts';
export * from './input.ts';
export * from './classifier.ts';
export { SYSTEM_PROMPT, candidateText } from './prompt.ts';
export {
  createAnthropicClassifier,
  ANTHROPIC_DEFAULT_MODEL,
  type AnthropicClassifierOptions,
} from './providers/anthropic.ts';
export { createFakeClassifier, type FakeClassifierOptions } from './providers/fake.ts';

import type { ContentClassifier } from './classifier.ts';
import { createAnthropicClassifier } from './providers/anthropic.ts';

export interface ClassifierConfig {
  CLASSIFIER_PROVIDER?: 'anthropic' | 'none' | undefined;
  ANTHROPIC_API_KEY?: string | undefined;
  CLASSIFIER_MODEL?: string | undefined;
}

export type ClassifierSetup =
  { configured: true; classifier: ContentClassifier } | { configured: false; reason: string };

/**
 * The single place a provider is chosen. With no provider configured, callers
 * get a reason — never a stand-in that fabricates output.
 */
export function createClassifier(config: ClassifierConfig): ClassifierSetup {
  const provider = config.CLASSIFIER_PROVIDER ?? (config.ANTHROPIC_API_KEY ? 'anthropic' : 'none');
  if (provider === 'none') {
    return {
      configured: false,
      reason: 'no classifier configured (set ANTHROPIC_API_KEY, or CLASSIFIER_PROVIDER=anthropic)',
    };
  }
  if (!config.ANTHROPIC_API_KEY) {
    return { configured: false, reason: 'CLASSIFIER_PROVIDER=anthropic needs ANTHROPIC_API_KEY' };
  }
  return {
    configured: true,
    classifier: createAnthropicClassifier({
      apiKey: config.ANTHROPIC_API_KEY,
      ...(config.CLASSIFIER_MODEL ? { model: config.CLASSIFIER_MODEL } : {}),
    }),
  };
}
