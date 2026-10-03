import type { Command } from 'commander';
import { QUERY_KIND_CAPABILITY } from '@vd/adapter-contract';
import { unconfiguredMessage } from '@vd/adapter-wiring';
import { SourceQueryKindSchema, type SourceQueryKind } from '@vd/core';
import {
  runDiscovery,
  runSourceQuery,
  type EnrichmentSummary,
  type RunSummary,
} from '@vd/pipeline';
import type { CommandIO } from '../output.ts';
import {
  CliError,
  collectParam,
  fail,
  loadRuntime,
  positiveInt,
  withPipeline,
  type CliRuntime,
} from '../runtime.ts';

interface DiscoverOpts {
  kind?: string;
  param?: Record<string, string | string[]>;
  region?: string;
  limit: number;
  maxDuration?: number;
  source?: string;
  query?: string;
  json?: boolean;
}

function defaultKind(runtime: CliRuntime, adapterId: string): SourceQueryKind {
  const adapter = runtime.wired.registry.get(adapterId);
  const kind = SourceQueryKindSchema.options.find((k) =>
    adapter.manifest.capabilities.includes(QUERY_KIND_CAPABILITY[k]),
  );
  if (!kind) throw new CliError(`adapter "${adapterId}" has no discovery capability`);
  return kind;
}

export function printEnrichment(io: CommandIO, e: EnrichmentSummary, label: string): void {
  io.out(
    `${label}: ${e.enriched}/${e.considered} via canonical adapters · ${e.notFound} not found · ${e.failed} failed · ${e.noAdapter} without a configured adapter`,
  );
  for (const r of e.results
    .filter((x) => x.status === 'failed' || x.status === 'not_found')
    .slice(0, 5))
    io.out(`  - ${r.platform} ${r.videoId}: ${r.status} (${'message' in r ? r.message : ''})`);
}

export function printRun(io: CommandIO, run: RunSummary): void {
  const ok = run.status === 'succeeded';
  const s = run.stats;
  io.out(
    `${ok ? '✔' : '✖'} ${run.adapterId} via source "${run.source}": ${run.status} (run ${run.runId})`,
  );
  io.out(
    `  found ${run.itemsFound} · new ${run.itemsNew} · updated ${s.videosUpdated} · sightings ${s.sightingsCreated} · snapshots ${s.snapshotsCreated} · filtered ${s.filtered} · quarantined ${s.invalid}`,
  );
  const quota = Object.entries(s.quotaUsed).map(([b, n]) => `${b}=${n}`);
  if (quota.length) io.out(`  quota used: ${quota.join(', ')}`);
  if (s.enrichment) printEnrichment(io, s.enrichment, '  references enriched');
  if (s.keptWithUnknownDuration)
    io.out(`  kept ${s.keptWithUnknownDuration} with unknown duration`);
  for (const f of s.filteredSamples.slice(0, 5))
    io.out(`  - filtered ${f.platformVideoId}: ${f.reason}`);
  for (const q of s.invalidSamples.slice(0, 5))
    io.out(`  ! quarantined ${q.externalId}: ${q.errors.join('; ')}`);
  if (run.error) io.out(`  error: ${run.error}`);
}

export function registerDiscover(program: Command, io: CommandIO): void {
  program
    .command('discover')
    .description(
      'Run discovery through one adapter (or a stored source query) and store the results',
    )
    .argument('[adapter]', 'adapter id, e.g. youtube, twitch, bluesky (see "adapters")')
    .option(
      '--kind <kind>',
      `query kind: ${SourceQueryKindSchema.options.join(' | ')} (default: first the adapter supports)`,
    )
    .option('--param <key=value>', 'adapter parameter; repeat for more or for lists', collectParam)
    .option('--region <code>', 'region hint passed to the adapter')
    .option('--limit <n>', 'maximum items to take from the adapter', positiveInt('--limit'), 50)
    .option(
      '--max-duration <seconds>',
      'skip videos longer than this (after normalization; recorded on the run)',
      positiveInt('--max-duration'),
    )
    .option('--source <name>', 'source row to record the run under (default: adapter id)')
    .option('--query <uuid>', 'run a stored source_queries row instead of ad-hoc params')
    .option('--json', 'output JSON')
    .addHelpText(
      'after',
      `
Examples:
  vd discover youtube --param regionCode=US,GB --param videoCategoryId=23 --max-duration 180
  vd discover twitch --param gameId=509658 --param lookbackHours=24
  vd discover twitch --kind channel_feed --param broadcasterId=12345
  vd discover bluesky --param q=funny --param domain=youtube.com
  vd discover --query 0f8fad5b-d9cb-469f-a165-70867728950e`,
    )
    .action(async (adapterId: string | undefined, opts: DiscoverOpts) => {
      const json = opts.json ?? false;
      try {
        const runtime = loadRuntime(io);
        const filters = opts.maxDuration ? { maxDurationMs: opts.maxDuration * 1000 } : {};
        let run: RunSummary;
        if (opts.query) {
          if (adapterId) throw new CliError('pass either an adapter or --query, not both');
          run = await withPipeline(runtime, (deps) =>
            runSourceQuery(deps, opts.query as string, { limit: opts.limit, filters }),
          );
        } else {
          if (!adapterId)
            throw new CliError(
              'missing adapter (e.g. "vd discover bluesky --param q=funny"); see "vd adapters"',
            );
          const why = unconfiguredMessage(runtime.wired.statuses, adapterId);
          if (why) throw new CliError(why);
          if (!runtime.wired.registry.has(adapterId)) {
            throw new CliError(`unknown adapter "${adapterId}"; see "vd adapters"`);
          }
          let kind: SourceQueryKind;
          if (opts.kind) {
            const parsed = SourceQueryKindSchema.safeParse(opts.kind);
            if (!parsed.success)
              throw new CliError(
                `--kind must be one of ${SourceQueryKindSchema.options.join(', ')}`,
              );
            kind = parsed.data;
          } else {
            kind = defaultKind(runtime, adapterId);
          }
          run = await withPipeline(runtime, (deps) =>
            runDiscovery(deps, {
              adapterId,
              kind,
              params: opts.param ?? {},
              region: opts.region ?? null,
              limit: opts.limit,
              filters,
              ...(opts.source ? { sourceName: opts.source } : {}),
            }),
          );
        }
        if (json) io.out(JSON.stringify({ ok: run.status === 'succeeded', run }, null, 2));
        else printRun(io, run);
        if (run.status !== 'succeeded') process.exitCode = 1;
      } catch (err) {
        fail(io, json, err);
      }
    });
}
