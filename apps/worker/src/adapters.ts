import { AdapterRegistry } from '@vd/adapter-contract';

/**
 * The ONLY place platform adapters get wired into the process.
 * Phase 1: intentionally empty. Future phases add e.g. `registry.register(createYouTubeAdapter(...))`.
 */
export function buildAdapterRegistry(): AdapterRegistry {
  return new AdapterRegistry();
}
