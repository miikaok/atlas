import type { Command } from 'commander';
import chalk from 'chalk';
import type { Container } from 'inversify';
import type { AtlasConfig } from '@/utils/config';
import { ATLAS_CONFIG_TOKEN } from '@/utils/config';
import { VerificationService } from '@/services/verification.service';
import type { VerificationResult } from '@/services/verification.service';
import { logger } from '@/utils/logger';

type ContainerFactory = () => Container;

interface VerifyOptions {
  snapshot: string;
  tenant?: string;
}

/** Registers the `atlas verify` subcommand. */
export function register_verify_command(program: Command, get_container: ContainerFactory): void {
  program
    .command('verify')
    .description('Verify integrity of a backup snapshot')
    .requiredOption('-s, --snapshot <id>', 'snapshot identifier to verify')
    .option('-t, --tenant <id>', 'tenant identifier (defaults to config)')
    .action((options: VerifyOptions) => execute_verify(get_container(), options));
}

/** Resolves the tenant ID from CLI flag or config. */
function resolve_tenant_id(container: Container, options: VerifyOptions): string {
  if (options.tenant) return options.tenant;
  const config = container.get<AtlasConfig>(ATLAS_CONFIG_TOKEN);
  return config.tenant_id;
}

/** Runs integrity verification and logs the outcome. */
async function execute_verify(container: Container, options: VerifyOptions): Promise<void> {
  const tenant_id = resolve_tenant_id(container, options);
  logger.banner('Atlas Verify');
  logger.info(`Verifying snapshot ${chalk.cyan(options.snapshot)}...`);

  const verification_service = container.get(VerificationService);
  const result = await verification_service.verify_snapshot_integrity(tenant_id, options.snapshot);
  report_verification_result(result);
}

/** Prints a human-readable summary of the verification result. */
function report_verification_result(result: VerificationResult): void {
  if (result.failed.length === 0) {
    logger.success(
      `All ${chalk.green(String(result.total_checked))} objects passed integrity check`,
    );
    return;
  }

  logger.error(
    `${chalk.red(String(result.failed.length))} of ${result.total_checked} objects failed verification`,
  );
  for (const id of result.failed) {
    logger.error(`  - ${id}`);
  }
  process.exitCode = 1;
}
