import type { Command } from 'commander';
import { submitUrl, UnsupportedUrlError } from '@vd/pipeline';
import { resolveVideoUrl } from '@vd/url-identity';
import type { CommandIO } from '../output.ts';
import { CliError, fail, loadRuntime, withPipeline } from '../runtime.ts';

export function registerSubmitUrl(program: Command, io: CommandIO): void {
  program
    .command('submit-url')
    .description(
      'Record a video URL you found (YouTube, TikTok, Twitch clip); works without platform credentials',
    )
    .argument('<url>', 'video URL')
    .option('--json', 'output JSON')
    .action(async (url: string, opts: { json?: boolean }) => {
      const json = opts.json ?? false;
      try {
        // Reject unsupported URLs before touching configuration or the database.
        const resolved = resolveVideoUrl(url);
        // Recognized short links (TikTok /t/, vm., vt.) are expanded by the recording adapter.
        if (!resolved.ok && resolved.reason !== 'short_link')
          throw new CliError(`unsupported URL (${resolved.reason}): ${resolved.message}`);
        const runtime = loadRuntime(io);
        const result = await withPipeline(runtime, (deps) => submitUrl(deps, url));
        if (json) {
          io.out(JSON.stringify({ ok: true, ...result }, null, 2));
          return;
        }
        const { video, enrichment, run } = result;
        io.out(`✔ ${video.platform} ${video.platformVideoId} → ${video.canonicalUrl}`);
        io.out(`  title: ${video.title ?? '(unknown)'} · availability: ${video.availability}`);
        io.out(
          `  recorded by ${run.adapterId} (run ${run.runId}, ${run.itemsNew ? 'new video' : 'already known'})`,
        );
        const detail =
          enrichment.status === 'enriched'
            ? `enriched via ${enrichment.adapterId}${enrichment.snapshot ? ' (metric snapshot stored)' : ''}`
            : `${enrichment.status}: ${enrichment.message}`;
        io.out(`  enrichment: ${detail}`);
      } catch (err) {
        fail(io, json, err instanceof UnsupportedUrlError ? new CliError(err.message) : err);
      }
    });
}
