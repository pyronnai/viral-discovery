import type { Command } from 'commander';
import { enrichReferences } from '@vd/pipeline';
import type { CommandIO } from '../output.ts';
import { fail, loadRuntime, positiveInt, withPipeline } from '../runtime.ts';
import { printEnrichment } from './discover.ts';

/**
 * Backfill for videos only ever seen as references (e.g. a YouTube link in a
 * Bluesky post): looks each up once on its canonical platform's adapter. New
 * discovery runs do this automatically; this covers older rows. Bounded by --limit.
 */
export function registerEnrichReferences(program: Command, io: CommandIO): void {
  program
    .command('enrich-references')
    .description(
      'Look up videos seen only as references (no authoritative observation yet) on their canonical platform, if that adapter is configured',
    )
    .option(
      '--limit <n>',
      'maximum videos to look up (one metered request each)',
      positiveInt('--limit'),
      25,
    )
    .option('--video <id...>', 'only these video ids')
    .option('--json', 'output JSON')
    .action(async (opts: { limit: number; video?: string[]; json?: boolean }) => {
      const json = opts.json ?? false;
      try {
        const runtime = loadRuntime(io);
        const summary = await withPipeline(runtime, (deps) =>
          enrichReferences(deps, {
            limit: opts.limit,
            ...(opts.video ? { videoIds: opts.video } : {}),
          }),
        );
        const ok = summary.failed === 0;
        if (json) io.out(JSON.stringify({ ok, summary }, null, 2));
        else printEnrichment(io, summary, `${ok ? '✔' : '✖'} references enriched`);
        if (!ok) process.exitCode = 1;
      } catch (err) {
        fail(io, json, err);
      }
    });
}
