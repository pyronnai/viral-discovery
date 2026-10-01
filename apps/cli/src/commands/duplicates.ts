import type { Command } from 'commander';
import { sql } from 'drizzle-orm';
import { DUPLICATE_STATUSES } from '@vd/core';
import {
  createThumbnailHasher,
  explainPair,
  scanDuplicates,
  summarizeEvidence,
  type DuplicateAssessment,
  type DuplicateEvidence,
  type ScanSummary,
} from '@vd/dedupe';
import type { CommandIO } from '../output.ts';
import { CliError, fail, loadRuntime, positiveInt, withPipeline } from '../runtime.ts';

function printScan(io: CommandIO, s: ScanSummary): void {
  const thumbs = Object.entries(s.thumbnails)
    .map(([k, v]) => `${k} ${v}`)
    .join(', ');
  io.out(
    `${s.errors.length ? '✖' : '✔'} duplicates scan: ${s.targets} videos · ${s.comparisons} comparisons · ${s.suggested} new possible · ${s.autoConfirmed} auto-confirmed · ${s.withdrawn} withdrawn · ${s.keptDecisions} human decisions kept`,
  );
  if (thumbs) io.out(`  thumbnails: ${thumbs}`);
  for (const e of s.errors) io.out(`  ! ${e.videoId}: ${e.message}`);
}

export function printAssessment(io: CommandIO, a: DuplicateAssessment): void {
  const verdict =
    a.decision === 'auto_confirm'
      ? 'AUTO-CONFIRM (same video)'
      : a.decision === 'possible'
        ? 'POSSIBLE duplicate — needs human confirmation'
        : 'NOT a duplicate';
  io.out(
    `${verdict} · confidence ${a.confidence.toFixed(2)} · score ${a.score} (${a.detectorVersion})`,
  );
  for (const line of summarizeEvidence(a.evidence)) io.out(`  ${line}`);
  io.out(`  positive signals: ${a.positiveSignals.join(', ') || 'none'}`);
  if (a.vetoes.length) io.out(`  vetoes: ${a.vetoes.join(', ')}`);
  if (a.autoBlockers.length) io.out(`  not auto-confirmed because: ${a.autoBlockers.join(', ')}`);
}

export function registerDuplicates(program: Command, io: CommandIO): void {
  const duplicates = program
    .command('duplicates')
    .description('Near-duplicate detection across platforms (bounded, explainable)');

  duplicates
    .command('scan')
    .description('Analyze videos for near-duplicates (default: unprocessed videos)')
    .option('--unprocessed', 'only videos never analyzed (default without other scopes)')
    .option(
      '--recent <hours>',
      'videos first discovered within this many hours',
      positiveInt('--recent'),
    )
    .option('--platform <platform>', 'only videos from this canonical platform')
    .option('--video <id...>', 'specific video ids')
    .option('--cluster <id...>', 'videos of these clusters')
    .option('--limit <n>', 'maximum videos to analyze', positiveInt('--limit'), 100)
    .option('--no-thumbnails', 'do not fetch thumbnails (use hashes already stored)')
    .option('--no-auto-confirm', 'only suggest; never merge automatically')
    .option('--json', 'output JSON')
    .action(
      async (opts: {
        unprocessed?: boolean;
        recent?: number;
        platform?: string;
        video?: string[];
        cluster?: string[];
        limit: number;
        thumbnails: boolean;
        autoConfirm: boolean;
        json?: boolean;
      }) => {
        const json = opts.json ?? false;
        try {
          const runtime = loadRuntime(io);
          const summary = await withPipeline(runtime, (deps) =>
            scanDuplicates(deps.db, {
              scope: {
                ...(opts.unprocessed ? { unprocessedOnly: true } : {}),
                ...(opts.recent !== undefined ? { sinceHours: opts.recent } : {}),
                ...(opts.platform ? { platform: opts.platform } : {}),
                ...(opts.video?.length ? { videoIds: opts.video } : {}),
                ...(opts.cluster?.length ? { clusterIds: opts.cluster } : {}),
              },
              limit: opts.limit,
              hasher: opts.thumbnails ? createThumbnailHasher() : null,
              autoConfirm: opts.autoConfirm,
            }),
          );
          if (json) io.out(JSON.stringify({ ok: summary.errors.length === 0, summary }, null, 2));
          else printScan(io, summary);
          if (summary.errors.length) process.exitCode = 1;
        } catch (err) {
          fail(io, json, err);
        }
      },
    );

  duplicates
    .command('list')
    .description('List duplicate relationships')
    .option('--status <status>', `one of ${DUPLICATE_STATUSES.join(', ')}`, 'possible')
    .option('--limit <n>', 'maximum rows', positiveInt('--limit'), 25)
    .option('--json', 'output JSON')
    .action(async (opts: { status: string; limit: number; json?: boolean }) => {
      const json = opts.json ?? false;
      try {
        if (!(DUPLICATE_STATUSES as readonly string[]).includes(opts.status)) {
          throw new CliError(`--status must be one of ${DUPLICATE_STATUSES.join(', ')}`);
        }
        const runtime = loadRuntime(io);
        const rows = await withPipeline(runtime, async (deps) => {
          const result = (await deps.db.execute(sql`
            select d.id, d.status::text as status, d.confidence, d.reasons, d.evidence,
              va.id as "videoA", va.platform as "platformA", coalesce(va.title, va.caption) as "titleA", va.cluster_id as "clusterA",
              vb.id as "videoB", vb.platform as "platformB", coalesce(vb.title, vb.caption) as "titleB", vb.cluster_id as "clusterB"
            from duplicate_candidates d
            join videos va on va.id = d.video_a_id join videos vb on vb.id = d.video_b_id
            where d.status = ${opts.status}
            order by d.confidence desc, d.last_evaluated_at desc limit ${opts.limit}`)) as {
            rows: {
              id: string;
              status: string;
              confidence: number;
              reasons: string[];
              evidence: Record<string, unknown>;
              platformA: string;
              titleA: string | null;
              platformB: string;
              titleB: string | null;
            }[];
          };
          return result.rows;
        });
        if (json) {
          io.out(JSON.stringify({ ok: true, duplicates: rows }, null, 2));
          return;
        }
        if (!rows.length) io.out(`no ${opts.status} duplicates`);
        for (const r of rows) {
          io.out(
            `● ${r.id} ${r.status} ${r.confidence.toFixed(2)}  ${r.platformA} "${r.titleA ?? '—'}" ⇄ ${r.platformB} "${r.titleB ?? '—'}"`,
          );
          for (const line of summarizeEvidence(r.evidence as unknown as DuplicateEvidence))
            io.out(`    ${line}`);
        }
      } catch (err) {
        fail(io, json, err);
      }
    });

  duplicates
    .command('explain')
    .description('Show the evidence for two videos (read-only; stores nothing)')
    .argument('<videoA>', 'video id')
    .argument('<videoB>', 'video id')
    .option('--json', 'output JSON')
    .action(async (videoA: string, videoB: string, opts: { json?: boolean }) => {
      const json = opts.json ?? false;
      try {
        for (const id of [videoA, videoB]) {
          if (!/^[0-9a-f-]{36}$/i.test(id)) throw new CliError(`not a video id: ${id}`);
        }
        const runtime = loadRuntime(io);
        const assessment = await withPipeline(runtime, (deps) =>
          explainPair(deps.db, videoA, videoB),
        );
        if (!assessment) throw new CliError('video not found');
        if (json) io.out(JSON.stringify({ ok: true, assessment }, null, 2));
        else printAssessment(io, assessment);
      } catch (err) {
        fail(io, json, err);
      }
    });
}
