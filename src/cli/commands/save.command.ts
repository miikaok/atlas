import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import type { Command } from 'commander';
import chalk from 'chalk';
import type { Container } from 'inversify';
import type { AtlasConfig } from '@/utils/config';
import { ATLAS_CONFIG_TOKEN } from '@/utils/config';
import type { SaveUseCase, SaveResult, SaveOptions } from '@/ports/save/use-case.port';
import { SAVE_USE_CASE_TOKEN } from '@/ports/tokens/use-case.tokens';
import { logger } from '@/utils/logger';

type ContainerFactory = () => Container;

interface CliSaveOptions {
  snapshot?: string;
  tenant?: string;
  mailbox?: string;
  folder?: string;
  message?: string;
  startDate?: string;
  endDate?: string;
  output?: string;
  skipVerify?: boolean;
}

/** Registers the `atlas save` subcommand. */
export function register_save_command(program: Command, get_container: ContainerFactory): void {
  program
    .command('save')
    .description('Save backed-up emails as EML files in a compressed zip archive')
    .option('-s, --snapshot <id>', 'save from a specific snapshot')
    .option('-m, --mailbox <email>', 'save from all snapshots for this mailbox')
    .option('-t, --tenant <id>', 'tenant identifier (defaults to config)')
    .option('-f, --folder <name>', 'save only messages from this folder')
    .option('--message <ref>', 'save a single message by # from atlas list, or full ID')
    .option('--start-date <YYYY-MM-DD>', 'include snapshots created on or after this date')
    .option('--end-date <YYYY-MM-DD>', 'include snapshots created on or before this date')
    .option('-o, --output <path>', 'output zip file path (default: Restore-<timestamp>.zip)')
    .option('--skip-verify', 'skip SHA-256 integrity checks (faster on low-power systems)')
    .action((options: CliSaveOptions) => {
      validate_save_options(options);
      return execute_save(get_container(), options);
    });
}

function validate_save_options(options: CliSaveOptions): void {
  if (!options.snapshot && !options.mailbox) {
    logger.error('Either --snapshot (-s) or --mailbox (-m) is required.');
    process.exit(1);
  }
  if ((options.startDate || options.endDate) && options.snapshot && !options.mailbox) {
    logger.error('--start-date / --end-date can only be used with --mailbox (-m).');
    process.exit(1);
  }
}

function resolve_tenant_id(container: Container, options: CliSaveOptions): string {
  if (options.tenant) return options.tenant;
  const config = container.get<AtlasConfig>(ATLAS_CONFIG_TOKEN);
  return config.tenant_id;
}

function parse_date(value: string, label: string): Date {
  const d = new Date(value + 'T00:00:00Z');
  if (isNaN(d.getTime())) {
    logger.error(`Invalid ${label}: "${value}". Expected YYYY-MM-DD.`);
    process.exit(1);
  }
  return d;
}

async function confirm_overwrite(file_path: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`File "${file_path}" already exists. Overwrite? [Y/n] `, (answer) => {
      rl.close();
      const trimmed = answer.trim().toLowerCase();
      resolve(trimmed === '' || trimmed === 'y' || trimmed === 'yes');
    });
  });
}

async function execute_save(container: Container, options: CliSaveOptions): Promise<void> {
  const tenant_id = resolve_tenant_id(container, options);
  const save_service = container.get<SaveUseCase>(SAVE_USE_CASE_TOKEN);

  logger.banner('Atlas Save');
  logger.info(`Tenant: ${tenant_id}`);

  const save_options = build_save_options(options);

  if (save_options.output_path && existsSync(save_options.output_path)) {
    const proceed = await confirm_overwrite(save_options.output_path);
    if (!proceed) {
      logger.info('Cancelled.');
      return;
    }
  }

  if (options.snapshot && !options.mailbox) {
    return execute_snapshot_save(save_service, tenant_id, options, save_options);
  }

  return execute_mailbox_save(save_service, tenant_id, options, save_options);
}

function build_save_options(options: CliSaveOptions): SaveOptions {
  return {
    ...(options.folder && { folder_name: options.folder }),
    ...(options.message && { message_ref: options.message }),
    ...(options.output && { output_path: options.output }),
    ...(options.skipVerify && { skip_integrity_check: true }),
    ...(options.startDate && { start_date: parse_date(options.startDate, '--start-date') }),
    ...(options.endDate && { end_date: parse_date(options.endDate, '--end-date') }),
  };
}

async function execute_snapshot_save(
  service: SaveUseCase,
  tenant_id: string,
  cli_options: CliSaveOptions,
  save_options: SaveOptions,
): Promise<void> {
  logger.info(`Snapshot: ${chalk.cyan(cli_options.snapshot!)}`);
  if (cli_options.folder) logger.info(`Folder filter: ${chalk.cyan(cli_options.folder)}`);
  if (cli_options.message) logger.info(`Message: ${chalk.cyan(cli_options.message)}`);

  const result = await service.save_snapshot(tenant_id, cli_options.snapshot!, save_options);
  report_save_result(result);
}

async function execute_mailbox_save(
  service: SaveUseCase,
  tenant_id: string,
  cli_options: CliSaveOptions,
  save_options: SaveOptions,
): Promise<void> {
  const mailbox_id = cli_options.mailbox!.toLowerCase();
  logger.info(`Mailbox: ${chalk.cyan(mailbox_id)}`);

  if (cli_options.startDate) logger.info(`Start date: ${chalk.cyan(cli_options.startDate)}`);
  if (cli_options.endDate) logger.info(`End date:   ${chalk.cyan(cli_options.endDate)}`);
  if (cli_options.folder) logger.info(`Folder filter: ${chalk.cyan(cli_options.folder)}`);

  const result = await service.save_mailbox(tenant_id, mailbox_id, save_options);
  report_save_result(result);
}

function report_save_result(result: SaveResult): void {
  const size_mb = (result.total_bytes / (1024 * 1024)).toFixed(1);
  const att_info =
    result.attachment_count > 0
      ? ` + ${chalk.cyan(String(result.attachment_count))} attachments`
      : '';

  if (result.error_count === 0 && result.integrity_failures.length === 0) {
    logger.success(
      `Saved ${chalk.green(String(result.saved_count))} messages${att_info}` +
        ` (${chalk.cyan(size_mb + ' MB')}) to ${chalk.cyan(result.output_path)}`,
    );
    return;
  }

  if (result.integrity_failures.length > 0) {
    logger.warn(
      `${chalk.yellow(String(result.integrity_failures.length))} integrity check failures`,
    );
  }

  if (result.error_count > 0) {
    logger.warn(
      `Saved ${result.saved_count} messages with ` +
        `${chalk.yellow(String(result.error_count))} errors`,
    );
    for (const err of result.errors.slice(0, 10)) {
      logger.error(`  - ${err}`);
    }
    if (result.errors.length > 10) {
      logger.error(`  ... and ${result.errors.length - 10} more`);
    }
    process.exitCode = 1;
  }
}
