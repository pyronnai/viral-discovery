import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { createAnthropicClassifier } from './providers/anthropic.ts';

/**
 * Live model check. Skipped unless LIVE_API_TESTS=1 and LIVE_CLASSIFIER=1.
 * Credentials resolve like the SDK default (ANTHROPIC_API_KEY or an `ant` profile).
 * Costs one small request.
 */
describe.skipIf(!process.env['LIVE_API_TESTS'] || !process.env['LIVE_CLASSIFIER'])(
  'anthropic classifier (live)',
  () => {
    it('returns a schema-valid classification from text-only metadata', async () => {
      const classifier = createAnthropicClassifier({
        apiKey: process.env['ANTHROPIC_API_KEY'] ?? '',
        client: new Anthropic(),
        ...(process.env['CLASSIFIER_MODEL'] ? { model: process.env['CLASSIFIER_MODEL'] } : {}),
      });
      const r = await classifier.classify({
        platform: 'youtube',
        canonicalUrl: 'https://www.youtube.com/watch?v=xxxxxxxxxxx',
        title: 'My cat tries to catch the robot vacuum and ends up riding it',
        caption: 'He was not ready 😂 #cats #funny',
        durationMs: 38_000,
        publishedAt: null,
        creator: { displayName: 'Example Pets', handle: null },
        thumbnailUrl: null,
        discoveryContext: ['youtube: search "funny animals"'],
      });
      expect(r.result.labels.map((l) => l.label)).toContain('animals');
      expect(r.inputsUsed.thumbnail).toBe('none');
    }, 120_000);
  },
);
