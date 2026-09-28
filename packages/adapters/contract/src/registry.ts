import type { SourceQueryKind } from '@vd/core';
import { QUERY_KIND_CAPABILITY, type SourceAdapter } from './adapter.ts';
import type { AdapterCapability } from './manifest.ts';
import { assertValidAdapter } from './validate.ts';

/**
 * Holds the adapters available to this process. Core resolves adapters by id and
 * capability only — it never imports a platform adapter directly.
 */
export class AdapterRegistry {
  readonly #adapters = new Map<string, SourceAdapter>();

  register(adapter: SourceAdapter): this {
    assertValidAdapter(adapter);
    const { id } = adapter.manifest;
    if (this.#adapters.has(id)) throw new Error(`Adapter "${id}" is already registered`);
    this.#adapters.set(id, adapter);
    return this;
  }

  unregister(id: string): boolean {
    return this.#adapters.delete(id);
  }

  has(id: string): boolean {
    return this.#adapters.has(id);
  }

  get(id: string): SourceAdapter {
    const adapter = this.#adapters.get(id);
    if (!adapter) throw new Error(`No adapter registered with id "${id}"`);
    return adapter;
  }

  list(): SourceAdapter[] {
    return [...this.#adapters.values()];
  }

  get size(): number {
    return this.#adapters.size;
  }

  supports(id: string, capability: AdapterCapability): boolean {
    return this.#adapters.get(id)?.manifest.capabilities.includes(capability) ?? false;
  }

  supportsQueryKind(id: string, kind: SourceQueryKind): boolean {
    return this.supports(id, QUERY_KIND_CAPABILITY[kind]);
  }
}
