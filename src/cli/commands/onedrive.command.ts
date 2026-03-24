import type { Command } from 'commander';
import type { Container } from 'inversify';
import type { AtlasConfig } from '@/utils/config';
import { ATLAS_CONFIG_TOKEN } from '@/utils/config';
import type {
  OneDriveBackupUseCase,
  OneDriveCatalogUseCase,
  OneDriveVerificationUseCase,
} from '@/ports/onedrive/use-case.port';
import {
  ONEDRIVE_BACKUP_USE_CASE_TOKEN,
  ONEDRIVE_CATALOG_USE_CASE_TOKEN,
  ONEDRIVE_VERIFICATION_USE_CASE_TOKEN,
} from '@/ports/tokens/use-case.tokens';
import { logger } from '@/utils/logger';

type ContainerFactory = () => Container;

interface OneDriveTenantOptions {
  tenant?: string;
}

interface OneDriveBackupOptions extends OneDriveTenantOptions {
  owner: string;
  full?: boolean;
}

interface OneDriveListSnapshotsOptions extends OneDriveTenantOptions {
  owner: string;
}

interface OneDriveListVersionsOptions extends OneDriveTenantOptions {
  owner: string;
  file: string;
}

interface OneDriveVerifyOptions extends OneDriveTenantOptions {
  snapshot: string;
}

/** Registers `atlas onedrive` command group and its subcommands. */
export function register_onedrive_commands(
  program: Command,
  get_container: ContainerFactory,
): void {
  const group = program
    .command('onedrive')
    .description('OneDrive backup and verification commands');
  register_onedrive_backup(group, get_container);
  register_onedrive_list_snapshots(group, get_container);
  register_onedrive_list_versions(group, get_container);
  register_onedrive_verify(group, get_container);
}

function register_onedrive_backup(group: Command, get_container: ContainerFactory): void {
  group
    .command('backup')
    .description('Back up changed OneDrive files for one owner')
    .requiredOption('-o, --owner <id>', 'OneDrive owner identifier (user principal/email)')
    .option('--full', 'force full crawl by ignoring saved OneDrive delta cursor')
    .option('-t, --tenant <id>', 'tenant identifier (defaults to config)')
    .action((options: OneDriveBackupOptions) => execute_onedrive_backup(get_container(), options));
}

function register_onedrive_list_snapshots(group: Command, get_container: ContainerFactory): void {
  group
    .command('list-snapshots')
    .description('List OneDrive snapshots for one owner')
    .requiredOption('-o, --owner <id>', 'OneDrive owner identifier')
    .option('-t, --tenant <id>', 'tenant identifier (defaults to config)')
    .action((options: OneDriveListSnapshotsOptions) =>
      execute_onedrive_list_snapshots(get_container(), options),
    );
}

function register_onedrive_list_versions(group: Command, get_container: ContainerFactory): void {
  group
    .command('list-versions')
    .description('List all backed-up versions for a file')
    .requiredOption('-o, --owner <id>', 'OneDrive owner identifier')
    .requiredOption('-f, --file <ref>', 'file id or path')
    .option('-t, --tenant <id>', 'tenant identifier (defaults to config)')
    .action((options: OneDriveListVersionsOptions) =>
      execute_onedrive_list_versions(get_container(), options),
    );
}

function register_onedrive_verify(group: Command, get_container: ContainerFactory): void {
  group
    .command('verify')
    .description('Verify integrity of a OneDrive snapshot')
    .requiredOption('-s, --snapshot <id>', 'snapshot identifier')
    .option('-t, --tenant <id>', 'tenant identifier (defaults to config)')
    .action((options: OneDriveVerifyOptions) => execute_onedrive_verify(get_container(), options));
}

function resolve_tenant_id(container: Container, options: OneDriveTenantOptions): string {
  if (options.tenant) return options.tenant;
  return container.get<AtlasConfig>(ATLAS_CONFIG_TOKEN).tenant_id;
}

async function execute_onedrive_backup(
  container: Container,
  options: OneDriveBackupOptions,
): Promise<void> {
  const tenant_id = resolve_tenant_id(container, options);
  const backup = container.get<OneDriveBackupUseCase>(ONEDRIVE_BACKUP_USE_CASE_TOKEN);
  const result = await backup.backup_onedrive(tenant_id, options.owner, {
    force_full: options.full ?? false,
  });

  logger.banner('Atlas OneDrive Backup');
  logger.info(`Owner: ${result.owner_id}`);
  if (result.snapshot) {
    logger.success(`Snapshot ${result.snapshot.snapshot_id} created`);
    logger.info(`Changed files: ${result.summary.files_changed}`);
  } else {
    logger.info('No OneDrive changes detected. Snapshot skipped.');
  }
}

async function execute_onedrive_list_snapshots(
  container: Container,
  options: OneDriveListSnapshotsOptions,
): Promise<void> {
  const tenant_id = resolve_tenant_id(container, options);
  const catalog = container.get<OneDriveCatalogUseCase>(ONEDRIVE_CATALOG_USE_CASE_TOKEN);
  const snapshots = await catalog.list_onedrive_snapshots(tenant_id, options.owner);

  logger.banner('Atlas OneDrive Snapshots');
  if (snapshots.length === 0) {
    logger.info('No OneDrive snapshots found.');
    return;
  }

  for (const snapshot of snapshots) {
    logger.info(
      `${snapshot.snapshot_id}  ${snapshot.created_at.toISOString()}  files=${snapshot.total_files}`,
    );
  }
}

async function execute_onedrive_list_versions(
  container: Container,
  options: OneDriveListVersionsOptions,
): Promise<void> {
  const tenant_id = resolve_tenant_id(container, options);
  const catalog = container.get<OneDriveCatalogUseCase>(ONEDRIVE_CATALOG_USE_CASE_TOKEN);
  const versions = await catalog.list_onedrive_file_versions(
    tenant_id,
    options.owner,
    options.file,
  );

  logger.banner('Atlas OneDrive Versions');
  if (versions.length === 0) {
    logger.info('No versions found for this file.');
    return;
  }

  for (const version of versions) {
    logger.info(
      `${version.backup_at}  ${version.snapshot_id}  ${version.change_type}  ${version.parent_path}/${version.file_name}`,
    );
  }
}

async function execute_onedrive_verify(
  container: Container,
  options: OneDriveVerifyOptions,
): Promise<void> {
  const tenant_id = resolve_tenant_id(container, options);
  const verifier = container.get<OneDriveVerificationUseCase>(ONEDRIVE_VERIFICATION_USE_CASE_TOKEN);
  const result = await verifier.verify_onedrive_snapshot(tenant_id, options.snapshot);

  logger.banner('Atlas OneDrive Verify');
  if (result.failed_file_ids.length === 0 && result.index_issues.length === 0) {
    logger.success(`All ${result.total_checked} OneDrive entries passed verification`);
    return;
  }

  logger.error(
    `Verification failures: files=${result.failed_file_ids.length}, index=${result.index_issues.length}`,
  );
  for (const file_id of result.failed_file_ids) logger.error(`  blob mismatch: ${file_id}`);
  for (const issue of result.index_issues) logger.error(`  index issue: ${issue}`);
  process.exitCode = 1;
}
