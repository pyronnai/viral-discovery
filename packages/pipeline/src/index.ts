export {
  runDiscovery,
  runSourceQuery,
  getAdapter,
  enrichReferences,
  enrichFromCanonical,
  canonicalAdapter,
  MAX_ENRICHMENTS_PER_RUN,
  type EnrichmentResult,
  type EnrichmentSummary,
  type PipelineDeps,
  type DiscoverOptions,
  type DiscoveryFilters,
  type RunSummary,
  type RunStats,
} from './ingest.ts';
export { submitUrl, UnsupportedUrlError, type SubmitResult } from './submit.ts';
export { refreshMetrics, type RefreshOptions, type RefreshSummary } from './refresh.ts';
export { PipelineError, ensureSource } from './sources.ts';
export { readingsToColumns } from './persist.ts';
export {
  refreshDue,
  ladderStatus,
  parseLadder,
  resolvePolicy,
  RefreshPolicySchema,
  DEFAULT_REFRESH_POLICY,
  type RefreshPolicy,
  type DueSummary,
} from './refresh-policy.ts';
export {
  scoreVideo,
  rescore,
  selectForScoring,
  loadScoringInput,
  loadPopulation,
  type RescoreOptions,
  type RescoreScope,
  type RescoreSummary,
  type ScoreVideoResult,
} from './score.ts';
export { dueQueries, runDueQueries, type DueQuery } from './schedule.ts';
export {
  classifyCluster,
  classifyClusters,
  classifyEligible,
  selectClassificationCandidates,
  buildClassificationInput,
  clustersOfVideos,
  latestClassification,
  describeContext,
  DEFAULT_CLASSIFICATION_POLICY,
  type ClassificationPolicy,
  type ClassifyClusterResult,
  type ClassifySummary,
} from './classify.ts';
