import type { Command } from 'commander';
import type { Container } from 'inversify';
import chalk from 'chalk';
import type { AtlasConfig } from '@atlas/core';
import { ATLAS_CONFIG_TOKEN } from '@atlas/core';
import type { CatalogUseCase } from '@atlas/types';
import { CATALOG_USE_CASE_TOKEN } from '@atlas/types';
import type { AttachmentEntry } from '@atlas/types';
import { html_to_text } from '@atlas/core';
import { logger } from '@atlas/core';

type ContainerFactory = () => Container;

interface ReadOptions {
  tenant?: string;
  snapshot: string;
  message: string;
  raw?: boolean;
}

/** Registers the `atlas read` subcommand. */
export function register_read_command(program: Command, get_container: ContainerFactory): void {
  program
    .command('read')
    .description('Decrypt and display a single backed-up message')
    .requiredOption('-s, --snapshot <id>', 'snapshot containing the message')
    .requiredOption('--message <ref>', 'message # from atlas list, or full message ID')
    .option('-t, --tenant <id>', 'tenant identifier (defaults to config)')
    .option('--raw', 'output the full JSON blob instead of formatted view')
    .action((options: ReadOptions) => execute_read(get_container(), options));
}

/** Fetches, decrypts, and displays a single message. */
async function execute_read(container: Container, options: ReadOptions): Promise<void> {
  const tenant_id = resolve_tenant_id(container, options);
  logger.banner('Atlas Read');

  const catalog = container.get<CatalogUseCase>(CATALOG_USE_CASE_TOKEN);
  const result = await catalog.read_message(tenant_id, options.snapshot, options.message);

  if (!result) {
    logger.error(`Message not found. Check the snapshot ID and message ID are correct.`);
    process.exitCode = 1;
    return;
  }

  if (options.raw) {
    console.log(JSON.stringify(result.message, null, 2));
    return;
  }

  print_formatted_message(result.message);
  print_attachment_list(result.attachments);
}

/** Resolves the tenant ID from CLI flag or config. */
function resolve_tenant_id(container: Container, options: ReadOptions): string {
  if (options.tenant) return options.tenant;
  return container.get<AtlasConfig>(ATLAS_CONFIG_TOKEN).tenant_id;
}

/** Lists attachment metadata (name, MIME type, size) if any exist. */
function print_attachment_list(attachments: AttachmentEntry[]): void {
  if (attachments.length === 0) return;

  console.log(chalk.gray('-'.repeat(60)));
  console.log(chalk.bold(`Attachments (${attachments.length}):`));

  for (let i = 0; i < attachments.length; i++) {
    const a = attachments[i]!;
    const inline_tag = a.is_inline ? chalk.gray('  (inline)') : '';
    const skipped = !a.storage_key ? chalk.yellow('  [binary not stored]') : '';
    console.log(
      `  ${i + 1}. ${a.name}  ${chalk.gray(a.content_type)}  ${format_bytes(a.size_bytes)}` +
        inline_tag +
        skipped,
    );
  }
}

/** Formats bytes into human-readable size. */
function format_bytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/** Prints key message fields in a human-readable format. */
function print_formatted_message(msg: Record<string, unknown>): void {
  const subject = safe_string(msg['subject']);
  const from = format_recipient(msg['from']);
  const to = format_recipients(msg['toRecipients']);
  const cc = format_recipients(msg['ccRecipients']);
  const received = safe_string(msg['receivedDateTime']);
  const body = extract_body_preview(msg['body']);

  console.log(chalk.bold('Subject: ') + subject);
  console.log(chalk.bold('From:    ') + from);
  console.log(chalk.bold('To:      ') + to);
  if (cc) console.log(chalk.bold('Cc:      ') + cc);
  console.log(chalk.bold('Date:    ') + received);
  console.log(chalk.gray('-'.repeat(60)));
  console.log(body);
}

/** Extracts the body content, stripping HTML tags for readability. */
function extract_body_preview(body: unknown): string {
  if (!body || typeof body !== 'object') return '(no body)';

  const obj = body as Record<string, unknown>;
  const content = safe_string(obj['content']);

  if (!content) return '(empty body)';

  if (safe_string(obj['contentType']).toLowerCase() === 'html') {
    return html_to_text(content);
  }

  return content;
}

/** Formats a Graph API { emailAddress: { name, address } } object. */
function format_recipient(recipient: unknown): string {
  if (!recipient || typeof recipient !== 'object') return '(unknown)';

  const obj = recipient as Record<string, unknown>;
  const email_address = obj['emailAddress'] as Record<string, unknown> | undefined;
  if (!email_address) return '(unknown)';

  const name = safe_string(email_address['name']);
  const address = safe_string(email_address['address']);

  return name && name !== address ? `${name} <${address}>` : address || '(unknown)';
}

/** Formats an array of Graph API recipient objects. */
function format_recipients(recipients: unknown): string {
  if (!Array.isArray(recipients) || recipients.length === 0) return '';
  return recipients.map((r) => format_recipient(r)).join(', ');
}

function safe_string(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
