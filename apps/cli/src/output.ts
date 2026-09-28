export type CheckStatus = 'pass' | 'warn' | 'fail';

export interface CheckResult {
  name: string;
  status: CheckStatus;
  detail: string;
  data?: Record<string, unknown>;
}

export interface CommandIO {
  out(line: string): void;
  err(line: string): void;
  /** Environment to read configuration from; defaults to process.env (tests inject one). */
  env?: Record<string, string | undefined>;
}

export const processIO: CommandIO = {
  out: (l) => process.stdout.write(`${l}\n`),
  err: (l) => process.stderr.write(`${l}\n`),
};

const ICON: Record<CheckStatus, string> = { pass: '✔', warn: '!', fail: '✖' };

export function printResults(io: CommandIO, results: CheckResult[], json: boolean): void {
  if (json) {
    io.out(JSON.stringify({ ok: exitCodeFor(results) === 0, checks: results }, null, 2));
    return;
  }
  for (const r of results) io.out(`${ICON[r.status]} ${r.name}: ${r.detail}`);
}

/** 0 = all pass/warn, 1 = any failure. */
export function exitCodeFor(results: CheckResult[]): number {
  return results.some((r) => r.status === 'fail') ? 1 : 0;
}
