import type { Command } from 'commander';
import type { Container } from 'inversify';
import type { AtlasConfig } from '@/utils/config';
import { ATLAS_CONFIG_TOKEN } from '@/utils/config';
import { MailboxSyncService } from '@/services/mailbox-sync.service';
import type { SyncOptions } from '@/services/mailbox-sync.service';
import { logger } from '@/utils/logger';

type ContainerFactory = () => Container;

interface BackupOptions {
  tenant?: string;
  mailbox?: string;
  folder?: string[];
  full?: boolean;
  pageSize?: string;
}

/** Registers the `atlas backup` subcommand. */
export function register_backup_command(program: Command, get_container: ContainerFactory): void {
  program
    .command('backup')
    .description('Back up mailboxes from M365 tenant to object storage')
    .option('-t, --tenant <id>', 'tenant identifier (defaults to config)')
    .option('-m, --mailbox <id>', 'specific mailbox to back up (backs up all if omitted)')
    .option('-f, --folder <name...>', 'specific folder(s) to back up (e.g. -f Inbox "Sent Items")')
    .option('--full', 'force a full backup, ignoring saved delta state from prior runs')
    .option('-P, --page-size <n>', 'Graph API page size per delta request (1-100)', '25')
    .action((options: BackupOptions) => execute_backup(get_container(), options));
}

/** Resolves the tenant ID from CLI flag or config. */
function resolve_tenant_id(container: Container, options: BackupOptions): string {
  if (options.tenant) return options.tenant;
  const config = container.get<AtlasConfig>(ATLAS_CONFIG_TOKEN);
  return config.tenant_id;
}

/** Builds SyncOptions from CLI flags. */
function build_sync_options(options: BackupOptions): SyncOptions {
  const page_size = Math.max(1, Math.min(100, parseInt(options.pageSize ?? '25', 10) || 25));
  return {
    folder_filter: options.folder,
    force_full: options.full ?? false,
    page_size,
  };
}

/** Dispatches a backup run for a single mailbox or the entire tenant. */
async function execute_backup(container: Container, options: BackupOptions): Promise<void> {
  const tenant_id = resolve_tenant_id(container, options);
  logger.banner('Atlas Backup');
  logger.info(`Tenant:  ${tenant_id}`);

  if (options.folder) {
    logger.info(`Folders: ${options.folder.join(', ')}`);
  }

  if (options.mailbox) {
    await backup_single_mailbox(container, tenant_id, options.mailbox, build_sync_options(options));
  } else {
    logger.info('Backing up all mailboxes...');
    logger.warn('Full-tenant backup not yet implemented');
  }
}

/** Runs a single-mailbox backup and logs the outcome. */
async function backup_single_mailbox(
  container: Container,
  tenant_id: string,
  mailbox_id: string,
  sync_options: SyncOptions,
): Promise<void> {
  logger.info(`Mailbox: ${mailbox_id}`);
  const sync_service = container.get(MailboxSyncService);
  const result = await sync_service.sync_mailbox(tenant_id, mailbox_id, sync_options);
  logger.success(
    `Snapshot ${result.snapshot.id} -- ` +
      `${result.manifest.total_objects} objects, ` +
      format_bytes(result.manifest.total_size_bytes),
  );
}

/** Formats bytes into human-readable size. */
function format_bytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}
