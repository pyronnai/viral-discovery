import type { Command } from 'commander';
import { parseLadder, refreshDue, refreshMetrics } from '@vd/pipeline';
import type { CommandIO } from '../output.ts';
import { fail, loadRuntime, positiveInt, withPipeline } from '../runtime.ts';
import { printDue } from './scheduling.ts';

export function registerRefreshMetrics(program: Command, io: CommandIO): void {
  program
    .command('refresh-metrics')
    .description(
      'Append metric snapshots for stored videos of one platform (least recently refreshed first, or --due by the refresh ladder)',
    )
    .argument('<platform>', 'canonical platform, e.g. youtube, twitch, bluesky')
    .option('--limit <n>', 'maximum videos to refresh', positiveInt('--limit'), 200)
    .option('--due', 'only videos whose refresh-ladder step is due')
    .option('--ladder <steps>', 'with --due: override the ladder, e.g. 2h,8h,24h,72h')
    .option('--json', 'output JSON')
    .action(
      async (
        platform: string,
        opts: { limit: number; due?: boolean; ladder?: string; json?: boolean },
      ) => {
        const json = opts.json ?? false;
        try {
          const ladder = opts.ladder ? parseLadder(opts.ladder) : undefined;
          const runtime = loadRuntime(io);
          if (opts.due) {
            const summary = await withPipeline(runtime, (deps) =>
              refreshDue(deps, {
                platform,
                limit: opts.limit,
                ...(ladder ? { policy: { ladderMinutes: ladder } } : {}),
              }),
            );
            const ok = summary.error === null && summary.invalid.length === 0;
            if (json) io.out(JSON.stringify({ ok, summary }, null, 2));
            else printDue(io, summary);
            if (!ok) process.exitCode = 1;
            return;
          }
          const summary = await withPipeline(runtime, (deps) =>
            refreshMetrics(deps, { platform, limit: opts.limit }),
          );
          const ok = summary.error === null && summary.invalid.length === 0;
          if (json) {
            io.out(JSON.stringify({ ok, summary }, null, 2));
          } else {
            io.out(
              `${ok ? '✔' : '✖'} ${platform} via ${summary.adapterId}: ${summary.requested} requested · ${summary.snapshotsCreated} snapshots · ${summary.unavailable} unavailable · ${summary.invalid.length} invalid`,
            );
            const quota = Object.entries(summary.quotaUsed).map(([b, n]) => `${b}=${n}`);
            if (quota.length) io.out(`  quota used: ${quota.join(', ')}`);
            if (summary.error) io.out(`  error: ${summary.error}`);
          }
          if (!ok) process.exitCode = 1;
        } catch (err) {
          fail(io, json, err);
        }
      },
    );
}
