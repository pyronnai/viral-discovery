import type { Command } from 'commander';
import {
  parseLadder,
  refreshDue,
  rescore,
  runDueQueries,
  type DueSummary,
  type PipelineDeps,
  type RescoreScope,
  type RescoreSummary,
} from '@vd/pipeline';
import { explainScore } from '@vd/scoring';
import type { CommandIO } from '../output.ts';
import { CliError, fail, loadRuntime, positiveInt, withPipeline } from '../runtime.ts';
import { printRun } from './discover.ts';

/** Platforms that a configured adapter can refresh (derived from manifests, never names). */
export function refreshablePlatforms(deps: PipelineDeps): string[] {
  const platforms = deps.registry
    .list()
    .filter((a) => a.manifest.capabilities.includes('metrics.refresh'))
    .map((a) => a.manifest.platform);
  return [...new Set(platforms)].sort();
}

export function printDue(io: CommandIO, s: DueSummary): void {
  const ok = s.error === null && s.invalid.length === 0;
  const error = s.error ? ` · error: ${s.error}` : '';
  io.out(
    `${ok ? '✔' : '✖'} refresh ${s.platform} (ladder ${s.policy.ladderMinutes.join('/')} min): ${s.considered} in window · ${s.due} due · ${s.snapshotsCreated} snapshots · ${s.unavailable} unavailable${error}`,
  );
}

function printRescore(io: CommandIO, s: RescoreSummary, explain: boolean, top: number): void {
  const states =
    Object.entries(s.byState)
      .map(([k, n]) => `${k}=${n}`)
      .join(', ') || 'none';
  io.out(
    `✔ rescore (${s.algorithmVersion}): ${s.considered} considered · ${s.created} new · ${s.unchanged} unchanged · ${states}`,
  );
  for (const f of s.failures) io.out(`  ! ${f.videoId}: ${f.error}`);
  const ranked = [...s.results]
    .filter((r) => r.result.score !== null)
    .sort((a, b) => (b.result.score ?? 0) - (a.result.score ?? 0))
    .slice(0, top);
  for (const r of ranked) {
    if (explain) {
      io.out(`  video ${r.videoId}`);
      for (const line of explainScore(r.result)) io.out(`  ${line}`);
    } else {
      io.out(`  ${String(r.result.score).padStart(5)}  ${r.result.state.padEnd(12)} ${r.videoId}`);
    }
  }
}

export function scopeFrom(opts: {
  video?: string[];
  unscored?: boolean;
  recent?: number;
}): RescoreScope {
  const chosen = [Boolean(opts.video?.length), Boolean(opts.unscored), Boolean(opts.recent)].filter(
    Boolean,
  );
  if (chosen.length > 1)
    throw new CliError('choose one of --video, --unscored, --recent (default: stale)');
  if (opts.video?.length) return { kind: 'videos', videoIds: opts.video };
  if (opts.unscored) return { kind: 'unscored' };
  if (opts.recent) return { kind: 'recent', hours: opts.recent };
  return { kind: 'stale' };
}

export function registerScheduling(program: Command, io: CommandIO): void {
  program
    .command('discover-due')
    .description('Run every enabled stored query whose cadence has elapsed')
    .option('--limit <n>', 'maximum items per query', positiveInt('--limit'), 50)
    .option('--json', 'output JSON')
    .action(async (opts: { limit: number; json?: boolean }) => {
      const json = opts.json ?? false;
      try {
        const runtime = loadRuntime(io);
        const result = await withPipeline(runtime, (deps) =>
          runDueQueries(deps, { limit: opts.limit }),
        );
        const ok = result.runs.every((r) => r.status === 'succeeded');
        if (json) io.out(JSON.stringify({ ok, ...result }, null, 2));
        else {
          if (result.runs.length === 0) io.out('✔ no queries due');
          for (const run of result.runs) printRun(io, run);
          for (const s of result.skipped)
            io.out(`- skipped ${s.queryId} (${s.source}): ${s.reason}`);
        }
        if (!ok) process.exitCode = 1;
      } catch (err) {
        fail(io, json, err);
      }
    });

  program
    .command('rescore')
    .description('Recalculate virality scores; by default only videos with new evidence (stale)')
    .option('--video <id...>', 'specific video ids')
    .option('--unscored', 'only videos without a score for the current algorithm')
    .option(
      '--recent <hours>',
      'videos first discovered in the last N hours',
      positiveInt('--recent'),
    )
    .option('--platform <platform>', 'restrict to one canonical platform')
    .option('--limit <n>', 'maximum videos', positiveInt('--limit'), 500)
    .option('--force', 'store a new score even if the evidence is unchanged')
    .option('--explain', 'print the component breakdown of the top results')
    .option('--top <n>', 'how many top results to print', positiveInt('--top'), 10)
    .option('--json', 'output JSON')
    .action(
      async (opts: {
        video?: string[];
        unscored?: boolean;
        recent?: number;
        platform?: string;
        limit: number;
        force?: boolean;
        explain?: boolean;
        top: number;
        json?: boolean;
      }) => {
        const json = opts.json ?? false;
        try {
          const scope = scopeFrom(opts);
          const runtime = loadRuntime(io);
          const summary = await withPipeline(runtime, (deps) =>
            rescore(deps, {
              scope,
              limit: opts.limit,
              ...(opts.platform ? { platform: opts.platform } : {}),
              ...(opts.force ? { force: true } : {}),
            }),
          );
          if (json) io.out(JSON.stringify({ ok: summary.failures.length === 0, summary }, null, 2));
          else printRescore(io, summary, opts.explain ?? false, opts.top);
          if (summary.failures.length) process.exitCode = 1;
        } catch (err) {
          fail(io, json, err);
        }
      },
    );

  program
    .command('tick')
    .description(
      'One scheduling pass: due queries → due metric refreshes → rescore stale (run from cron)',
    )
    .option(
      '--limit <n>',
      'maximum items per query / videos per platform',
      positiveInt('--limit'),
      200,
    )
    .option('--ladder <steps>', 'override the refresh ladder, e.g. 2h,8h,24h,72h')
    .option('--json', 'output JSON')
    .action(async (opts: { limit: number; ladder?: string; json?: boolean }) => {
      const json = opts.json ?? false;
      try {
        const ladder = opts.ladder ? parseLadder(opts.ladder) : undefined;
        const runtime = loadRuntime(io);
        const result = await withPipeline(runtime, async (deps) => {
          const discovery = await runDueQueries(deps, { limit: opts.limit });
          const refreshes: DueSummary[] = [];
          for (const platform of refreshablePlatforms(deps)) {
            refreshes.push(
              await refreshDue(deps, {
                platform,
                limit: opts.limit,
                ...(ladder ? { policy: { ladderMinutes: ladder } } : {}),
              }),
            );
          }
          const scoring = await rescore(deps, { scope: { kind: 'stale' }, limit: opts.limit });
          return { discovery, refreshes, scoring };
        });
        const ok =
          result.discovery.runs.every((r) => r.status === 'succeeded') &&
          result.refreshes.every((r) => r.error === null) &&
          result.scoring.failures.length === 0;
        if (json) io.out(JSON.stringify({ ok, ...result }, null, 2));
        else {
          if (result.discovery.runs.length === 0) io.out('✔ no queries due');
          for (const run of result.discovery.runs) printRun(io, run);
          for (const s of result.discovery.skipped)
            io.out(`- skipped query ${s.queryId}: ${s.reason}`);
          for (const r of result.refreshes) printDue(io, r);
          printRescore(io, result.scoring, false, 5);
        }
        if (!ok) process.exitCode = 1;
      } catch (err) {
        fail(io, json, err);
      }
    });
}
