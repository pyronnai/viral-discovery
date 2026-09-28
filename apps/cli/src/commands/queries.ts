import type { Command } from 'commander';
import { desc, eq } from 'drizzle-orm';
import { QUERY_KIND_CAPABILITY } from '@vd/adapter-contract';
import { SourceQueryKindSchema } from '@vd/core';
import { schema } from '@vd/db';
import { ensureSource } from '@vd/pipeline';
import type { CommandIO } from '../output.ts';
import {
  CliError,
  collectParam,
  fail,
  loadRuntime,
  positiveInt,
  withPipeline,
} from '../runtime.ts';

/**
 * Persistent discovery configuration: stored SourceQueries with a cadence.
 * Search terms, regions, channels, games live here — never in adapter code.
 */
export function registerQueries(program: Command, io: CommandIO): void {
  const queries = program
    .command('queries')
    .description('Manage stored source queries (persistent discovery config)');

  queries
    .command('list')
    .description('List stored source queries')
    .option('--json', 'output JSON')
    .action(async (opts: { json?: boolean }) => {
      const json = opts.json ?? false;
      try {
        const runtime = loadRuntime(io);
        const rows = await withPipeline(runtime, (deps) =>
          deps.db
            .select({ query: schema.sourceQueries, source: schema.sources })
            .from(schema.sourceQueries)
            .innerJoin(schema.sources, eq(schema.sources.id, schema.sourceQueries.sourceId))
            .orderBy(desc(schema.sourceQueries.createdAt)),
        );
        if (json) {
          const list = rows.map((r) => ({
            ...r.query,
            source: r.source.name,
            adapterId: r.source.adapterId,
          }));
          io.out(JSON.stringify({ ok: true, queries: list }, null, 2));
          return;
        }
        if (rows.length === 0) io.out('no stored queries (add one with "vd queries add")');
        for (const { query, source } of rows) {
          const cadence = query.cadenceMinutes ? `every ${query.cadenceMinutes}m` : 'manual';
          const state = query.enabled ? '●' : '○';
          io.out(
            `${state} ${query.id} ${source.name}/${source.adapterId} ${query.kind} ${cadence} ${JSON.stringify(query.params)}`,
          );
        }
      } catch (err) {
        fail(io, json, err);
      }
    });

  queries
    .command('add')
    .description('Store a source query')
    .argument('<adapter>', 'adapter id, e.g. youtube, twitch, bluesky')
    .requiredOption('--kind <kind>', SourceQueryKindSchema.options.join(' | '))
    .option('--param <key=value>', 'adapter parameter; repeat for more or for lists', collectParam)
    .option('--region <code>', 'region hint')
    .option(
      '--cadence <minutes>',
      'run every N minutes via "discover-due"/"tick" (omit for manual only)',
      positiveInt('--cadence'),
    )
    .option('--source <name>', 'source row name (default: adapter id)')
    .option('--disabled', 'store without enabling')
    .option('--json', 'output JSON')
    .addHelpText(
      'after',
      `
Examples:
  vd queries add youtube --kind search --param q="funny animals" --param publishedWithinHours=48 --param order=viewCount --cadence 360
  vd queries add youtube --kind trending --param regionCode=US,GB --cadence 120
  vd queries add youtube --kind channel_feed --param channelId=UC... --param maxPerChannel=5 --cadence 180
  vd queries add twitch --kind trending --param gameId=509658 --param lookbackHours=24 --cadence 180
  vd queries add bluesky --kind search --param q=funny --param domain=tiktok.com --cadence 60`,
    )
    .action(
      async (
        adapterId: string,
        opts: {
          kind: string;
          param?: Record<string, string | string[]>;
          region?: string;
          cadence?: number;
          source?: string;
          disabled?: boolean;
          json?: boolean;
        },
      ) => {
        const json = opts.json ?? false;
        try {
          const runtime = loadRuntime(io);
          const kind = SourceQueryKindSchema.safeParse(opts.kind);
          if (!kind.success) {
            throw new CliError(`--kind must be one of ${SourceQueryKindSchema.options.join(', ')}`);
          }
          const status = runtime.wired.statuses.find((s) => s.id === adapterId);
          if (!status) throw new CliError(`unknown adapter "${adapterId}"; see "vd adapters"`);
          if (!status.capabilities.includes(QUERY_KIND_CAPABILITY[kind.data])) {
            throw new CliError(`adapter "${adapterId}" does not support kind "${kind.data}"`);
          }
          const manifest = runtime.wired.registry.has(adapterId)
            ? runtime.wired.registry.get(adapterId).manifest
            : null;
          const row = await withPipeline(runtime, async (deps) => {
            let sourceId: string;
            if (manifest) {
              sourceId = (await ensureSource(deps.db, manifest, opts.source)).id;
            } else {
              // Queries can be stored for unconfigured adapters; they run once credentials exist.
              const name = opts.source ?? adapterId;
              await deps.db
                .insert(schema.sources)
                .values({ name, adapterId, enabled: true })
                .onConflictDoNothing();
              const [s] = await deps.db
                .select()
                .from(schema.sources)
                .where(eq(schema.sources.name, name));
              if (!s || s.adapterId !== adapterId)
                throw new CliError(`source "${name}" belongs to another adapter`);
              sourceId = s.id;
            }
            const [inserted] = await deps.db
              .insert(schema.sourceQueries)
              .values({
                sourceId,
                kind: kind.data,
                params: opts.param ?? {},
                region: opts.region ?? null,
                cadenceMinutes: opts.cadence ?? null,
                enabled: !opts.disabled,
              })
              .returning();
            return inserted;
          });
          if (json) io.out(JSON.stringify({ ok: true, query: row }, null, 2));
          else {
            const note = status.configured
              ? ''
              : ` (adapter not configured yet: set ${status.missingEnv.join(', ')})`;
            io.out(`✔ stored query ${row?.id ?? '?'}${note}`);
          }
        } catch (err) {
          fail(io, json, err);
        }
      },
    );

  for (const [name, enabled] of [
    ['enable', true],
    ['disable', false],
  ] as const) {
    queries
      .command(name)
      .description(`${enabled ? 'Enable' : 'Disable'} a stored query`)
      .argument('<id>', 'source query id')
      .option('--json', 'output JSON')
      .action(async (id: string, opts: { json?: boolean }) => {
        const json = opts.json ?? false;
        try {
          const runtime = loadRuntime(io);
          const rows = await withPipeline(runtime, (deps) =>
            deps.db
              .update(schema.sourceQueries)
              .set({ enabled })
              .where(eq(schema.sourceQueries.id, id))
              .returning({ id: schema.sourceQueries.id }),
          );
          if (rows.length === 0) throw new CliError(`source query ${id} not found`);
          if (json) io.out(JSON.stringify({ ok: true, id, enabled }, null, 2));
          else io.out(`✔ ${name}d ${id}`);
        } catch (err) {
          fail(io, json, err);
        }
      });
  }
}
