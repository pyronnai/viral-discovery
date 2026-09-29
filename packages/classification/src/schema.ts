import { z } from 'zod';
import { CONTENT_LABELS, SAFETY_FLAGS } from './taxonomy.ts';

const confidence = z.number().min(0).max(1);
const text = z.string().trim().min(1).max(600);

/**
 * The shape the model must produce (sent as a JSON schema via structured output).
 * Unknowns are explicit nulls. Numeric/length bounds are validated client-side.
 */
export const ModelOutputSchema = z.object({
  summary: text.describe('One neutral sentence describing what the video appears to show.'),
  labels: z
    .array(
      z.object({
        label: z.enum(CONTENT_LABELS),
        confidence: confidence.describe('0-1: how well the available inputs support this label'),
      }),
    )
    .describe('All labels that apply (multi-label). Use "other" only if nothing else fits.'),
  safetyFlags: z
    .array(
      z.object({
        flag: z.enum(SAFETY_FLAGS),
        confidence,
        note: text.describe(
          'What in the inputs suggests this. No claims about identity or legality.',
        ),
      }),
    )
    .describe('Review flags for a human. Empty when none apply.'),
  analysis: z.object({
    hook: text.nullable(),
    setup: text.nullable(),
    payoff: text.nullable(),
    emotionalDriver: text.nullable(),
    novelty: text.nullable(),
    pacingNotes: text.nullable(),
    audienceAppeal: text.nullable(),
    reusableFormat: text.nullable(),
    suggestedTheme: text.nullable(),
    whyItMayWork: text.nullable(),
  }),
});
export type ModelOutput = z.infer<typeof ModelOutputSchema>;

/**
 * Product-level validation on top of the schema: at least one label, no duplicate
 * labels or flags, and "other" never mixed with specific labels.
 */
export const ClassificationResultSchema = ModelOutputSchema.superRefine((value, ctx) => {
  if (value.labels.length === 0) {
    ctx.addIssue({ code: 'custom', path: ['labels'], message: 'at least one label is required' });
  }
  const labels = value.labels.map((l) => l.label);
  if (new Set(labels).size !== labels.length) {
    ctx.addIssue({ code: 'custom', path: ['labels'], message: 'duplicate labels' });
  }
  if (labels.includes('other') && labels.length > 1) {
    ctx.addIssue({
      code: 'custom',
      path: ['labels'],
      message: '"other" cannot be combined with other labels',
    });
  }
  const flags = value.safetyFlags.map((f) => f.flag);
  if (new Set(flags).size !== flags.length) {
    ctx.addIssue({ code: 'custom', path: ['safetyFlags'], message: 'duplicate flags' });
  }
});
export type ClassificationResult = z.infer<typeof ClassificationResultSchema>;

export type ValidationOutcome =
  { ok: true; value: ClassificationResult } | { ok: false; errors: string[] };

/** Validates untrusted model output; invalid output is reported, never stored. */
export function validateClassification(raw: unknown): ValidationOutcome {
  const parsed = ClassificationResultSchema.safeParse(raw);
  if (parsed.success) {
    // Stable ordering so identical meaning produces identical records.
    const value = {
      ...parsed.data,
      labels: [...parsed.data.labels].sort(
        (a, b) => b.confidence - a.confidence || a.label.localeCompare(b.label),
      ),
      safetyFlags: [...parsed.data.safetyFlags].sort((a, b) => a.flag.localeCompare(b.flag)),
    };
    return { ok: true, value };
  }
  return {
    ok: false,
    errors: parsed.error.issues.map((i) => `${i.path.join('.') || 'output'}: ${i.message}`),
  };
}
