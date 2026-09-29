/**
 * Content taxonomy and review flags. Changing any list or definition is a new
 * TAXONOMY_VERSION; changing the prompt wording is a new PROMPT_VERSION. Both are
 * stored on every classification so candidates can be reclassified later.
 */
export const TAXONOMY_VERSION = 'content-taxonomy-v1';
export const PROMPT_VERSION = 'content-prompt-v1';

/** Multi-label: a video may carry several (e.g. funny + animals + unexpected). */
export const CONTENT_LABELS = [
  'funny',
  'fails',
  'animals',
  'reactions',
  'memes',
  'unexpected',
  'wholesome',
  'prank',
  'gaming',
  'sports',
  'other',
] as const;
export type ContentLabel = (typeof CONTENT_LABELS)[number];

export const LABEL_DEFINITIONS: Record<ContentLabel, string> = {
  funny: 'primarily intended to be humorous',
  fails: 'someone or something visibly failing, falling, or going wrong (non-serious)',
  animals: 'animals or pets are central',
  reactions: 'a person reacting to something is the main content',
  memes: 'uses or creates a recognizable meme format or trend',
  unexpected: 'a surprise, twist, or outcome viewers would not predict',
  wholesome: 'warm, kind, or heartwarming',
  prank: 'someone is deliberately tricked',
  gaming: 'video games or game streams',
  sports: 'sports or athletic performance',
  other: 'none of the above fits well',
};

/**
 * Suitability flags for HUMAN review. They describe cues in the available inputs;
 * they never assert illegality or make claims about identifiable people, and
 * flagged candidates are never removed automatically.
 */
export const SAFETY_FLAGS = [
  'serious_injury',
  'violence',
  'minors',
  'sexual_or_nsfw',
  'tragedy_or_death',
  'dangerous_behavior',
  'potentially_distressing',
] as const;
export type SafetyFlag = (typeof SAFETY_FLAGS)[number];

export const FLAG_DEFINITIONS: Record<SafetyFlag, string> = {
  serious_injury: 'cues suggesting someone may be seriously hurt (beyond a harmless tumble)',
  violence: 'fighting, assault, or weapons',
  minors: 'people who appear to be children or teenagers are shown',
  sexual_or_nsfw: 'sexual or otherwise not-safe-for-work content',
  tragedy_or_death: 'death, disaster, or grief',
  dangerous_behavior: 'stunts or actions that could encourage risky imitation',
  potentially_distressing: 'content some viewers may find upsetting (e.g. animal distress)',
};

/** Flags that should be visually prominent in the dashboard. */
export const SIGNIFICANT_FLAGS: readonly SafetyFlag[] = [
  'serious_injury',
  'violence',
  'minors',
  'sexual_or_nsfw',
  'tragedy_or_death',
];

/** "Why this may work" fields — model hypotheses, never facts. */
export const ANALYSIS_FIELDS = [
  'hook',
  'setup',
  'payoff',
  'emotionalDriver',
  'novelty',
  'pacingNotes',
  'audienceAppeal',
  'reusableFormat',
  'suggestedTheme',
  'whyItMayWork',
] as const;
export type AnalysisField = (typeof ANALYSIS_FIELDS)[number];
