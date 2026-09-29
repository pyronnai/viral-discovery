import type { Command } from 'commander';
import { createClassifier, type ClassificationResult } from '@vd/classification';
import {
  DEFAULT_CLASSIFICATION_POLICY,
  classifyClusters,
  classifyEligible,
  clustersOfVideos,
  latestClassification,
  type ClassifySummary,
} from '@vd/pipeline';
import type { CommandIO } from '../output.ts';
import { CliError, fail, loadRuntime, positiveInt, withPipeline } from '../runtime.ts';

function explainRow(
  io: CommandIO,
  row: NonNullable<Awaited<ReturnType<typeof latestClassification>>>,
): void {
  const labels = row.labels.map((l) => `${l.label} ${l.confidence.toFixed(2)}`).join(', ');
  io.out(`    AI summary: ${row.rationale ?? '—'}`);
  io.out(`    labels: ${labels}`);
  io.out(
    `    flags: ${row.safetyFlags.length ? row.safetyFlags.map((f) => `${f.flag} (${f.note})`).join('; ') : 'none'}`,
  );
  const analysis = row.analysis as Partial<ClassificationResult['analysis']>;
  if (analysis.whyItMayWork) io.out(`    why it may work (hypothesis): ${analysis.whyItMayWork}`);
  io.out(
    `    ${row.provider}/${row.model} · ${row.taxonomyVersion} · ${row.promptVersion} · thumbnail ${String(row.inputsUsed['thumbnail'])}`,
  );
}

export function registerClassify(program: Command, io: CommandIO): void {
  program
    .command('classify')
    .description('Classify candidate clusters (content labels, review flags, AI content analysis)')
    .option('--eligible', 'clusters that pass the classification gate (default)')
    .option('--cluster <id...>', 'specific cluster ids')
    .option('--video <id...>', 'the clusters of these video ids')
    .option('--force', 'classify again even if unchanged for the current taxonomy/prompt')
    .option('--limit <n>', 'maximum clusters', positiveInt('--limit'), 25)
    .option('--min-score <n>', 'gate threshold (default CLASSIFICATION_MIN_SCORE)', Number)
    .option('--explain', 'print the stored classification for each processed cluster')
    .option('--json', 'output JSON')
    .action(
      async (opts: {
        eligible?: boolean;
        cluster?: string[];
        video?: string[];
        force?: boolean;
        limit: number;
        minScore?: number;
        explain?: boolean;
        json?: boolean;
      }) => {
        const json = opts.json ?? false;
        try {
          if ((opts.cluster?.length || opts.video?.length) && opts.eligible) {
            throw new CliError('use either --eligible or --cluster/--video');
          }
          const runtime = loadRuntime(io);
          const setup = createClassifier(runtime.config);
          if (!setup.configured) throw new CliError(`classifier unavailable: ${setup.reason}`);
          const { classifier } = setup;
          const policy = {
            ...DEFAULT_CLASSIFICATION_POLICY,
            minScore: opts.minScore ?? runtime.config.CLASSIFICATION_MIN_SCORE,
          };
          const summary: ClassifySummary = await withPipeline(runtime, async (deps) => {
            const explicit = [
              ...(opts.cluster ?? []),
              ...(await clustersOfVideos(deps, opts.video ?? [])),
            ];
            const result = explicit.length
              ? await classifyClusters(deps, explicit.slice(0, opts.limit), {
                  classifier,
                  policy,
                  ...(opts.force ? { force: true } : {}),
                })
              : await classifyEligible(deps, { classifier, policy, limit: opts.limit });
            if (opts.explain && !json) {
              for (const r of result.results) {
                io.out(
                  `● ${r.clusterId}: ${r.status}${r.error ? ` (${r.error.kind}: ${r.error.message})` : r.reason ? ` (${r.reason})` : ''}`,
                );
                const row = await latestClassification(deps, r.clusterId);
                if (row) explainRow(io, row);
              }
            }
            return result;
          });
          const ok = summary.failed === 0;
          if (json)
            io.out(
              JSON.stringify(
                { ok, provider: classifier.provider, model: classifier.model, summary },
                null,
                2,
              ),
            );
          else {
            io.out(
              `${ok ? '✔' : '✖'} classify (${classifier.provider}/${classifier.model}): ${summary.considered} considered · ${summary.classified} classified · ${summary.unchanged} unchanged · ${summary.failed} failed · ${summary.skipped} skipped`,
            );
            if (!opts.explain) {
              for (const r of summary.results.filter((x) => x.error)) {
                io.out(`  ! ${r.clusterId}: ${r.error?.kind ?? ''} ${r.error?.message ?? ''}`);
              }
            }
          }
          if (!ok) process.exitCode = 1;
        } catch (err) {
          fail(io, json, err);
        }
      },
    );
}
