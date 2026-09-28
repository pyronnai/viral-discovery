import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { isEntrypoint } from './migrate.ts';

const dir = mkdtempSync(join(tmpdir(), 'vd migrate ü-'));
const script = join(dir, 'migrate.ts');
const other = join(dir, 'other.ts');
const link = join(dir, 'link.ts');
writeFileSync(script, '');
writeFileSync(other, '');
symlinkSync(script, link);
const url = pathToFileURL(script).href;

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('isEntrypoint', () => {
  it('matches when the path contains spaces and non-ASCII characters', () => {
    expect(url).toContain('%20');
    expect(isEntrypoint(url, script)).toBe(true);
  });

  it('matches relative and symlinked entry paths', () => {
    expect(isEntrypoint(url, relative(process.cwd(), script))).toBe(true);
    expect(isEntrypoint(url, link)).toBe(true);
  });

  it('does not match other scripts, missing files, or a missing argv[1]', () => {
    expect(isEntrypoint(url, other)).toBe(false);
    expect(isEntrypoint(url, join(dir, 'missing.ts'))).toBe(false);
    expect(isEntrypoint(url, undefined)).toBe(false);
  });
});
