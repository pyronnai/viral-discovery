import type { Command } from 'commander';
import type { CommandIO } from '../output.ts';
import { registerConfigCheck } from './config-check.ts';
import { registerDbCheck } from './db-check.ts';
import { registerHealth } from './health.ts';

export type CommandRegistrar = (program: Command, io: CommandIO) => void;

/**
 * Every CLI command is registered here. Future commands (discover, rescore,
 * submit-url) get their own file and one line in this list — nothing else changes.
 */
export const COMMANDS: readonly CommandRegistrar[] = [
  registerHealth,
  registerConfigCheck,
  registerDbCheck,
];
