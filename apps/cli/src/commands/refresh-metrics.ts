import type { Command } from 'commander';
import { refreshMetrics } from '@vd/pipeline';
import type { CommandIO } from '../output.ts';
import { fail, loadRuntime, positiveInt, withPipeline } from '../runtime.ts';

export function registerRefreshMetrics(program: Command, io: CommandIO): void {
  program
    .command('refresh-metrics')
    .description(
      'Append metric snapshots for stored videos of one platform (least recently refreshed first)',
    )
    .argument('<platform>', 'canonical platform, e.g. youtube, twitch, bluesky')
    .option('--limit <n>', 'maximum videos to refresh', positiveInt('--limit'), 200)
    .option('--json', 'output JSON')
    .action(async (platform: string, opts: { limit: number; json?: boolean }) => {
      const json = opts.json ?? false;
      try {
        const runtime = loadRuntime(io);
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
    });
}
