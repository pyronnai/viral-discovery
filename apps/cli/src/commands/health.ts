import type { Command } from 'commander';
import { checkConfig, checkDb } from '../checks.ts';
import { exitCodeFor, printResults, type CheckResult, type CommandIO } from '../output.ts';

export function registerHealth(program: Command, io: CommandIO): void {
  program
    .command('health')
    .description('Run all infrastructure checks (config, database, schema, job queue)')
    .option('--json', 'output JSON')
    .action(async (opts: { json?: boolean }) => {
      const { result, config } = checkConfig();
      const results: CheckResult[] = [result];
      if (config) results.push(...(await checkDb(config)));
      else results.push({ name: 'database', status: 'fail', detail: 'skipped: config invalid' });
      results.push({
        name: 'runtime',
        status: 'pass',
        detail: `Node ${process.versions.node}`,
      });
      printResults(io, results, opts.json ?? false);
      process.exitCode = exitCodeFor(results);
    });
}
