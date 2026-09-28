import type { AppConfig } from '@vd/config';
import { buildAdapterRegistry as wire } from '@vd/adapter-wiring';
import type { AdapterRegistry } from '@vd/adapter-contract';

/** Adapters available to the worker; wiring lives in @vd/adapter-wiring (shared with the CLI). */
export function buildAdapterRegistry(config: AppConfig): AdapterRegistry {
  return wire(config).registry;
}
