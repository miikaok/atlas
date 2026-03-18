import type { Command } from 'commander';
import type { Container } from 'inversify';
import type { AtlasConfig } from '@/utils/config';
import { ATLAS_CONFIG_TOKEN } from '@/utils/config';
import type { StatsUseCase } from '@/ports/stats/use-case.port';
import { STATS_USE_CASE_TOKEN } from '@/ports/tokens/use-case.tokens';
import type { BucketStats, MailboxStats, FolderStats, MonthlyBreakdown } from '@/domain/stats';
import { logger } from '@/utils/logger';

type ContainerFactory = () => Container;

interface StatsOptions {
  tenant?: string;
  mailbox?: string;
  json?: boolean;
}

/** Registers the `atlas stats` subcommand for storage statistics. */
export function register_stats_command(program: Command, get_container: ContainerFactory): void {
  program
    .command('stats')
    .description('Show storage statistics for the bucket or a specific mailbox')
    .option('-t, --tenant <id>', 'tenant identifier (defaults to config)')
    .option('-m, --mailbox <email>', 'show statistics for a specific mailbox')
    .option('--json', 'output raw JSON instead of formatted table')
    .action((options: StatsOptions) => execute_stats(get_container(), options));
}

/** Routes to bucket-level or mailbox-level stats based on flags. */
async function execute_stats(container: Container, options: StatsOptions): Promise<void> {
  const tenant_id = resolve_tenant_id(container, options);
  const stats = container.get<StatsUseCase>(STATS_USE_CASE_TOKEN);

  if (options.mailbox) {
    const result = await stats.get_mailbox_stats(tenant_id, options.mailbox);
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      print_mailbox_stats(result);
    }
  } else {
    const result = await stats.get_bucket_stats(tenant_id);
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      print_bucket_stats(result);
    }
  }
}

/** Resolves the tenant ID from CLI flag or config. */
function resolve_tenant_id(container: Container, options: StatsOptions): string {
  if (options.tenant) return options.tenant;
  return container.get<AtlasConfig>(ATLAS_CONFIG_TOKEN).tenant_id;
}

// ---------------------------------------------------------------------------
// Bucket-level output
// ---------------------------------------------------------------------------

function print_bucket_stats(stats: BucketStats): void {
  logger.banner('Atlas Bucket Statistics');
  logger.info(`Tenant: ${stats.tenant_id}\n`);

  console.log('  Overview');
  console.log('  ' + '-'.repeat(44));
  console.log(`  Mailboxes:          ${stats.mailbox_count}`);
  console.log(`  Snapshots:          ${stats.snapshot_count}`);
  console.log(`  Messages:           ${stats.total_messages}`);
  console.log(`  Total size:         ${format_bytes(stats.total_size_bytes)}`);
  console.log(`  Attachments:        ${stats.attachment_count}`);
  console.log(`  Attachment size:    ${format_bytes(stats.attachment_size_bytes)}`);
  console.log(`  Aggregation time:   ${format_duration(stats.aggregation_us)}`);

  if (stats.monthly_breakdown.length > 0) {
    print_monthly_breakdown(stats.monthly_breakdown);
  }
}

// ---------------------------------------------------------------------------
// Mailbox-level output
// ---------------------------------------------------------------------------

function print_mailbox_stats(stats: MailboxStats): void {
  logger.banner('Atlas Mailbox Statistics');
  logger.info(`Mailbox: ${stats.mailbox_id}\n`);

  console.log('  Overview');
  console.log('  ' + '-'.repeat(44));
  console.log(`  Snapshots:          ${stats.snapshot_count}`);
  console.log(`  Messages:           ${stats.total_messages}`);
  console.log(`  Total size:         ${format_bytes(stats.total_size_bytes)}`);
  console.log(`  Attachments:        ${stats.attachment_count}`);
  console.log(`  Attachment size:    ${format_bytes(stats.attachment_size_bytes)}`);
  console.log(`  Aggregation time:   ${format_duration(stats.aggregation_us)}`);

  if (stats.folders.length > 0) {
    print_folder_table(stats.folders);
  }

  if (stats.monthly_breakdown.length > 0) {
    print_monthly_breakdown(stats.monthly_breakdown);
  }
}

// ---------------------------------------------------------------------------
// Shared tables
// ---------------------------------------------------------------------------

function print_folder_table(folders: FolderStats[]): void {
  console.log('\n  Folders');
  const header =
    '  ' + pad('Folder', 36) + pad('Messages', 12) + pad('Size', 12) + pad('Att', 8) + 'Att size';
  console.log(header);
  console.log('  ' + '-'.repeat(header.length - 2));

  for (const f of folders) {
    console.log(
      '  ' +
        pad(truncate(f.folder_id, 34), 36) +
        pad(String(f.message_count), 12) +
        pad(format_bytes(f.total_size_bytes), 12) +
        pad(String(f.attachment_count), 8) +
        format_bytes(f.attachment_size_bytes),
    );
  }
}

function print_monthly_breakdown(months: MonthlyBreakdown[]): void {
  console.log('\n  Monthly Breakdown');
  const header =
    '  ' +
    pad('Month', 12) +
    pad('Snapshots', 12) +
    pad('Messages', 12) +
    pad('Size', 12) +
    pad('Att', 8) +
    'Att size';
  console.log(header);
  console.log('  ' + '-'.repeat(header.length - 2));

  for (const m of months) {
    console.log(
      '  ' +
        pad(m.month, 12) +
        pad(String(m.snapshot_count), 12) +
        pad(String(m.message_count), 12) +
        pad(format_bytes(m.size_bytes), 12) +
        pad(String(m.attachment_count), 8) +
        format_bytes(m.attachment_size_bytes),
    );
  }
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function pad(str: string, width: number): string {
  return str.padEnd(width);
}

function truncate(str: string, max: number): string {
  return str.length > max ? str.slice(0, max - 1) + '~' : str;
}

function format_bytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function format_duration(us: number): string {
  if (us < 1000) return `${us} us`;
  const ms = us / 1000;
  if (ms < 1000) return `${ms.toFixed(2)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}
