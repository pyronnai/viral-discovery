import { Command } from 'commander';
import { COMMANDS } from './commands/index.ts';
import { processIO, type CommandIO } from './output.ts';

export function buildProgram(io: CommandIO = processIO): Command {
  const program = new Command()
    .name('vd')
    .description('viral-discovery infrastructure CLI')
    .showHelpAfterError()
    .configureOutput({
      writeOut: (s) => {
        io.out(s.trimEnd());
      },
      writeErr: (s) => {
        io.err(s.trimEnd());
      },
    });
  for (const register of COMMANDS) register(program, io);
  return program;
}
