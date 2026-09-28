import type { Command } from 'commander';
import { checkConfig, checkDb } from '../checks.ts';
import { exitCodeFor, printResults, type CommandIO } from '../output.ts';

export function registerDbCheck(program: Command, io: CommandIO): void {
  program
    .command('db-check')
    .description('Check database connectivity, migrations, and job-queue schema')
    .option('--json', 'output JSON')
    .action(async (opts: { json?: boolean }) => {
      const { result, config } = checkConfig();
      const results = config ? await checkDb(config) : [result];
      printResults(io, results, opts.json ?? false);
      process.exitCode = exitCodeFor(results);
    });
}
