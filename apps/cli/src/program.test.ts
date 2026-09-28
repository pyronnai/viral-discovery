import { describe, expect, it } from 'vitest';
import { buildProgram } from './program.ts';
import { checkConfig } from './checks.ts';
import { exitCodeFor } from './output.ts';

describe('cli program', () => {
  it('registers exactly the Phase 1 commands', () => {
    const names = buildProgram({ out: () => {}, err: () => {} }).commands.map((c) => c.name());
    expect(names.sort()).toEqual(['config-check', 'db-check', 'health']);
  });
});

describe('checkConfig', () => {
  it('fails with the validation issue when DATABASE_URL is missing', () => {
    const { result, config } = checkConfig({});
    expect(config).toBeNull();
    expect(result.status).toBe('fail');
    expect(result.detail).toMatch(/DATABASE_URL/);
  });

  it('redacts the password in its report', () => {
    const { result } = checkConfig({ DATABASE_URL: 'postgres://u:hunter2@localhost/db' });
    expect(result.status).toBe('pass');
    expect(result.detail).not.toContain('hunter2');
  });
});

describe('exitCodeFor', () => {
  it('only fails on "fail"', () => {
    expect(exitCodeFor([{ name: 'a', status: 'warn', detail: '' }])).toBe(0);
    expect(exitCodeFor([{ name: 'a', status: 'fail', detail: '' }])).toBe(1);
  });
});
