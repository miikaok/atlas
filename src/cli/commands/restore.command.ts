import type { Command } from 'commander';
import chalk from 'chalk';
import type { Container } from 'inversify';
import type { AtlasConfig } from '@/utils/config';
import { ATLAS_CONFIG_TOKEN } from '@/utils/config';
import { RestoreService } from '@/services/restore.service';
import type { RestoreResult } from '@/services/restore.service';
import { logger } from '@/utils/logger';

type ContainerFactory = () => Container;

interface RestoreOptions {
  snapshot: string;
  tenant?: string;
  mailbox?: string;
}

/** Registers the `atlas restore` subcommand. */
export function register_restore_command(program: Command, get_container: ContainerFactory): void {
  program
    .command('restore')
    .description('Restore emails from a backup snapshot')
    .requiredOption('-s, --snapshot <id>', 'snapshot identifier to restore from')
    .option('-t, --tenant <id>', 'tenant identifier (defaults to config)')
    .option('-m, --mailbox <id>', 'target mailbox (defaults to original)')
    .action((options: RestoreOptions) => execute_restore(get_container(), options));
}

/** Resolves the tenant ID from CLI flag or config. */
function resolve_tenant_id(container: Container, options: RestoreOptions): string {
  if (options.tenant) return options.tenant;
  const config = container.get<AtlasConfig>(ATLAS_CONFIG_TOKEN);
  return config.tenant_id;
}

/** Runs the restore operation and logs the outcome. */
async function execute_restore(container: Container, options: RestoreOptions): Promise<void> {
  const tenant_id = resolve_tenant_id(container, options);
  logger.banner('Atlas Restore');
  logger.info(`Restoring snapshot ${chalk.cyan(options.snapshot)}...`);

  const restore_service = container.get(RestoreService);
  const result = await restore_service.restore_snapshot(
    tenant_id,
    options.snapshot,
    options.mailbox,
  );
  report_restore_result(result);
}

/** Prints a human-readable summary of the restore result. */
function report_restore_result(result: RestoreResult): void {
  if (result.errors.length === 0) {
    logger.success(`Restored ${chalk.green(String(result.restored_count))} messages successfully`);
    return;
  }

  logger.warn(
    `Restored ${result.restored_count} messages with ${chalk.yellow(String(result.errors.length))} errors`,
  );
  for (const err of result.errors) {
    logger.error(`  - ${err}`);
  }
  process.exitCode = 1;
}
