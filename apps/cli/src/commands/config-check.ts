import type { Command } from 'commander';
import { checkConfig } from '../checks.ts';
import { exitCodeFor, printResults, type CommandIO } from '../output.ts';

export function registerConfigCheck(program: Command, io: CommandIO): void {
  program
    .command('config-check')
    .description('Validate environment configuration without connecting to anything')
    .option('--json', 'output JSON')
    .action((opts: { json?: boolean }) => {
      const { result } = checkConfig();
      printResults(io, [result], opts.json ?? false);
      process.exitCode = exitCodeFor([result]);
    });
}
