import { buildProgram } from './program.ts';

buildProgram()
  .parseAsync(process.argv)
  .catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
