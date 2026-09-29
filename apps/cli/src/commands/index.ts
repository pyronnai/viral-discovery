import type { Command } from 'commander';
import type { CommandIO } from '../output.ts';
import { registerAdapters } from './adapters.ts';
import { registerClassify } from './classify.ts';
import { registerConfigCheck } from './config-check.ts';
import { registerDbCheck } from './db-check.ts';
import { registerDiscover } from './discover.ts';
import { registerHealth } from './health.ts';
import { registerQueries } from './queries.ts';
import { registerRefreshMetrics } from './refresh-metrics.ts';
import { registerScheduling } from './scheduling.ts';
import { registerSubmitUrl } from './submit-url.ts';

export type CommandRegistrar = (program: Command, io: CommandIO) => void;

/**
 * Every CLI command is registered here. New commands get their own file and one
 * line in this list — nothing else changes.
 */
export const COMMANDS: readonly CommandRegistrar[] = [
  registerHealth,
  registerConfigCheck,
  registerDbCheck,
  registerAdapters,
  registerDiscover,
  registerSubmitUrl,
  registerRefreshMetrics,
  registerQueries,
  registerScheduling,
  registerClassify,
];
