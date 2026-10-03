export * from './types.ts';
export { BREAKOUT_V1_1_CONFIG, type BreakoutV1Config } from './config.ts';
export { scoreCandidateV1, percentile, strength } from './score.ts';
export {
  DEFAULT_SCORING_CONFIG,
  scoreCandidate,
  type ScoringConfig,
  type PlatformScales,
  type LogScale,
} from './v2.ts';
export { explainScore } from './explain.ts';
export { evidenceFingerprint } from './fingerprint.ts';
