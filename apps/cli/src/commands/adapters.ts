import type { Command } from 'commander';
import { PLANNED_ADAPTERS } from '@vd/adapter-wiring';
import type { CommandIO } from '../output.ts';
import { fail, loadRuntime } from '../runtime.ts';

export function registerAdapters(program: Command, io: CommandIO): void {
  program
    .command('adapters')
    .description('List source adapters, their capabilities, and whether they are configured')
    .option('--json', 'output JSON')
    .action((opts: { json?: boolean }) => {
      const json = opts.json ?? false;
      try {
        const { wired } = loadRuntime(io);
        if (json) {
          io.out(
            JSON.stringify(
              { ok: true, adapters: wired.statuses, planned: PLANNED_ADAPTERS },
              null,
              2,
            ),
          );
          return;
        }
        for (const s of wired.statuses) {
          const state = s.configured ? '✔ ready' : `! needs ${s.missingEnv.join(', ')}`;
          const refs = s.referencePlatforms.length
            ? ` · links to: ${s.referencePlatforms.join(', ')}`
            : '';
          io.out(`${state.padEnd(44)} ${s.id} — ${s.capabilities.join(', ')}${refs}`);
        }
        for (const p of PLANNED_ADAPTERS) io.out(`${'- planned'.padEnd(44)} ${p.id} — ${p.reason}`);
      } catch (err) {
        fail(io, json, err);
      }
    });
}
