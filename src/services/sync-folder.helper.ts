import { createHash } from 'node:crypto';
import type { TenantContext } from '@/ports/tenant-context.port';
import type { MailboxConnector, MailMessage } from '@/ports/mailbox-connector.port';
import type { ManifestEntry } from '@/domain/manifest';
import { fetch_and_store_attachments } from '@/services/attachment-sync.helper';
import { calc_rate } from '@/services/sync-progress.helper';
import type { BackupDashboard } from '@/services/backup-dashboard';

export interface FolderSyncResult {
  entries: ManifestEntry[];
  delta_link: string;
  stored: number;
  deduplicated: number;
  attachments_stored: number;
  folder_processed: number;
}

export interface FolderSyncParams {
  ctx: TenantContext;
  connector: MailboxConnector;
  tenant_id: string;
  mailbox_id: string;
  folder_id: string;
  folder_index: number;
  folder_total: number;
  global_total: number;
  global_processed_before: number;
  sync_start: number;
  dashboard: BackupDashboard;
  is_interrupted: () => boolean;
  prev_delta_link?: string;
  previous_manifest_entries?: number;
}

/** Runs a delta sync for one folder, driving the dashboard for live progress. */
export async function sync_single_folder(params: FolderSyncParams): Promise<FolderSyncResult> {
  const {
    ctx,
    connector,
    tenant_id,
    mailbox_id,
    folder_id,
    folder_index,
    global_total,
    global_processed_before,
    sync_start,
    dashboard,
    is_interrupted,
    prev_delta_link,
    folder_total,
  } = params;
  const previous_manifest_entries = params.previous_manifest_entries ?? 0;

  const page_start = Date.now();

  const on_page = (_page: number, items: number): void => {
    const elapsed_ms = Date.now() - page_start;
    const page_rate = calc_rate(items, elapsed_ms);
    const remaining = global_total - global_processed_before - items;
    const eta = page_rate > 0 ? remaining / page_rate : 0;
    dashboard.update_paging(folder_index, items, page_rate, eta);
    dashboard.update_total(global_processed_before, global_total, page_rate, eta);
  };

  let delta = await connector.fetch_delta(
    tenant_id,
    mailbox_id,
    folder_id,
    prev_delta_link,
    on_page,
  );

  if (
    prev_delta_link &&
    delta.messages.length === 0 &&
    folder_total > 0 &&
    previous_manifest_entries === 0
  ) {
    delta = await connector.fetch_delta(tenant_id, mailbox_id, folder_id, undefined, on_page);
  }

  const entries: ManifestEntry[] = [];
  let stored = 0,
    deduplicated = 0,
    att_stored = 0,
    folder_processed = 0;

  for (const message of delta.messages) {
    if (is_interrupted()) break;

    const entry = await store_single_message(ctx, message, mailbox_id);
    if (entry.was_new) stored++;
    else deduplicated++;

    const attachment_entries = message.has_attachments
      ? await fetch_and_store_attachments(ctx, connector, tenant_id, mailbox_id, message.message_id)
      : undefined;

    if (attachment_entries) att_stored += attachment_entries.length;

    entries.push(
      attachment_entries && attachment_entries.length > 0
        ? { ...entry.manifest_entry, attachments: attachment_entries }
        : entry.manifest_entry,
    );

    folder_processed++;
    const gp = global_processed_before + folder_processed;
    const rate = calc_rate(gp, Date.now() - sync_start);
    const eta = rate > 0 ? (global_total - gp) / rate : 0;
    dashboard.update_active(folder_index, folder_processed, rate, eta);
    dashboard.update_total(gp, global_total, rate, eta);
  }

  return {
    entries,
    delta_link: delta.delta_link,
    stored,
    deduplicated,
    attachments_stored: att_stored,
    folder_processed,
  };
}

/** Content-addressed storage with SHA-256 dedup: hash -> check exists -> encrypt -> upload. */
export async function store_single_message(
  ctx: TenantContext,
  message: MailMessage,
  mailbox_id: string,
): Promise<{ manifest_entry: ManifestEntry; was_new: boolean }> {
  const checksum = createHash('sha256').update(message.raw_body).digest('hex');
  const storage_key = `data/${mailbox_id}/${checksum}`;

  const already_stored = await ctx.storage.exists(storage_key);
  if (!already_stored) {
    const ciphertext = ctx.encrypt(message.raw_body);
    await ctx.storage.put(storage_key, ciphertext, {
      'x-message-id': message.message_id,
      'x-plaintext-sha256': checksum,
    });
  }

  const manifest_entry: ManifestEntry = {
    object_id: message.message_id,
    storage_key,
    checksum,
    size_bytes: message.size_bytes,
    subject: message.subject,
    folder_id: message.folder_id,
  };

  return { manifest_entry, was_new: !already_stored };
}
