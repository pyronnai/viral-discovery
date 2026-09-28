import { describe, expect, it } from 'vitest';
import type { SourceAdapter } from '../adapter.ts';
import { AdapterManifestSchema } from '../manifest.ts';
import type { RawItem } from '../normalized.ts';
import { checkAdapter, safeNormalize } from '../validate.ts';

export interface AdapterContractSuiteOptions {
  /** Factory so each test gets a fresh adapter instance. */
  create: () => SourceAdapter;
  /**
   * Recorded raw items (from real API responses, saved under fixtures/) that must
   * normalize successfully. Provide at least one per discovery capability.
   */
  validFixtures: readonly RawItem[];
  /** Raw items the adapter must reject (malformed/partial payloads). Optional. */
  invalidFixtures?: readonly RawItem[];
}

/**
 * Reusable compliance suite. Every real adapter's test file should call:
 *
 *   describeAdapterContract('youtube', { create, validFixtures, invalidFixtures });
 *
 * It checks the manifest, capability/method consistency, normalization output,
 * determinism, and that undeclared metrics never carry values.
 */
export function describeAdapterContract(name: string, options: AdapterContractSuiteOptions): void {
  describe(`adapter contract: ${name}`, () => {
    it('has a valid manifest', () => {
      const result = AdapterManifestSchema.safeParse(options.create().manifest);
      expect(result.success, JSON.stringify(result.error?.issues)).toBe(true);
    });

    it('implements exactly the capabilities it declares', () => {
      expect(checkAdapter(options.create())).toEqual([]);
    });

    it('provides at least one valid fixture', () => {
      expect(options.validFixtures.length).toBeGreaterThan(0);
    });

    it.each(options.validFixtures.map((f) => [f.externalId, f] as const))(
      'normalizes fixture %s into a valid NormalizedVideo',
      (_id, fixture) => {
        const adapter = options.create();
        const result = safeNormalize(adapter, fixture);
        expect(result.ok ? [] : result.errors).toEqual([]);
        if (result.ok) {
          expect(result.value.platformVideoId.length).toBeGreaterThan(0);
          expect(fixture.adapterId).toBe(adapter.manifest.id);
        }
      },
    );

    it('normalize() is deterministic', () => {
      const adapter = options.create();
      for (const fixture of options.validFixtures) {
        expect(adapter.normalize(fixture)).toEqual(adapter.normalize(fixture));
      }
    });

    if (options.invalidFixtures && options.invalidFixtures.length > 0) {
      it.each(options.invalidFixtures.map((f) => [f.externalId, f] as const))(
        'rejects invalid fixture %s without crashing the pipeline',
        (_id, fixture) => {
          expect(safeNormalize(options.create(), fixture).ok).toBe(false);
        },
      );
    }
  });
}
