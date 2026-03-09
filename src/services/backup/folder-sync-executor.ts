import { createHash } from 'node:crypto';
import type { TenantContext } from '@/ports/tenant/context.port';
import type { MailboxConnector, MailMessage } from '@/ports/mailbox/connector.port';
import type { ManifestEntry } from '@/domain/manifest';
import { fetch_and_store_attachments } from '@/services/backup/attachment-storage-sync';
import { calc_rate } from '@/services/shared/progress-rate';
import type { BackupProgressReporter, ObjectLockPolicy } from '@/ports/backup/use-case.port';

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
  progress: BackupProgressReporter;
  is_interrupted: () => boolean;
  is_hard_stopped: () => boolean;
  prev_delta_link?: string;
  previous_manifest_entries?: number;
  page_size?: number;
  object_lock_policy?: ObjectLockPolicy;
}

/** Processes a single message: dedup check, encrypt, store, fetch attachments. */
async function process_message(
  ctx: TenantContext,
  connector: MailboxConnector,
  tenant_id: string,
  mailbox_id: string,
  message: MailMessage,
  entries: ManifestEntry[],
  stats: { stored: number; deduplicated: number; att_stored: number },
  object_lock_policy?: ObjectLockPolicy,
): Promise<void> {
  const entry = await store_single_message(ctx, message, mailbox_id, object_lock_policy);
  if (entry.was_new) stats.stored++;
  else stats.deduplicated++;

  const att = message.has_attachments
    ? await fetch_and_store_attachments(
        ctx,
        connector,
        tenant_id,
        mailbox_id,
        message.message_id,
        undefined,
        object_lock_policy,
      )
    : undefined;

  if (att) stats.att_stored += att.length;

  entries.push(
    att && att.length > 0 ? { ...entry.manifest_entry, attachments: att } : entry.manifest_entry,
  );
}

/** Runs a delta sync for one folder, processing messages inline as pages arrive. */
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
    progress,
    is_interrupted,
    is_hard_stopped,
    prev_delta_link,
    folder_total,
    page_size,
    object_lock_policy,
  } = params;
  const previous_manifest_entries = params.previous_manifest_entries ?? 0;

  const entries: ManifestEntry[] = [];
  const stats = { stored: 0, deduplicated: 0, att_stored: 0 };
  let folder_processed = 0;
  let streamed = false;
  const page_start = Date.now();

  const on_page = async (
    _page: number,
    total_items: number,
    page_messages: MailMessage[],
  ): Promise<boolean> => {
    streamed = true;

    if (is_hard_stopped()) return false;

    const elapsed_ms = Date.now() - page_start;
    const page_rate = calc_rate(total_items, elapsed_ms);
    const remaining = global_total - global_processed_before - total_items;
    const eta = page_rate > 0 ? remaining / page_rate : 0;
    progress.update_paging(folder_index, total_items, page_rate, eta);

    if (is_interrupted()) return true;

    for (const message of page_messages) {
      if (is_interrupted()) break;
      await process_message(
        ctx,
        connector,
        tenant_id,
        mailbox_id,
        message,
        entries,
        stats,
        object_lock_policy,
      );
      folder_processed++;
      const gp = global_processed_before + folder_processed;
      const rate = calc_rate(gp, Date.now() - sync_start);
      const msg_eta = rate > 0 ? (global_total - gp) / rate : 0;
      progress.update_total(gp, global_total, rate, msg_eta);
      progress.update_active(folder_index, folder_processed, rate, msg_eta);
    }

    return true;
  };

  let delta = await connector.fetch_delta(
    tenant_id,
    mailbox_id,
    folder_id,
    prev_delta_link,
    on_page,
    page_size,
  );

  if (
    !is_interrupted() &&
    prev_delta_link &&
    delta.messages.length === 0 &&
    folder_total > 0 &&
    previous_manifest_entries === 0
  ) {
    delta = await connector.fetch_delta(
      tenant_id,
      mailbox_id,
      folder_id,
      undefined,
      on_page,
      page_size,
    );
  }

  if (!streamed) {
    for (const message of delta.messages) {
      if (is_interrupted()) break;
      await process_message(
        ctx,
        connector,
        tenant_id,
        mailbox_id,
        message,
        entries,
        stats,
        object_lock_policy,
      );
      folder_processed++;
      const gp = global_processed_before + folder_processed;
      const rate = calc_rate(gp, Date.now() - sync_start);
      const eta = rate > 0 ? (global_total - gp) / rate : 0;
      progress.update_total(gp, global_total, rate, eta);
      progress.update_active(folder_index, folder_processed, rate, eta);
    }
  }

  return {
    entries,
    delta_link: delta.delta_link,
    stored: stats.stored,
    deduplicated: stats.deduplicated,
    attachments_stored: stats.att_stored,
    folder_processed,
  };
}

/** Content-addressed storage with SHA-256 dedup: hash -> check exists -> encrypt -> upload. */
export async function store_single_message(
  ctx: TenantContext,
  message: MailMessage,
  mailbox_id: string,
  object_lock_policy?: ObjectLockPolicy,
): Promise<{ manifest_entry: ManifestEntry; was_new: boolean }> {
  const checksum = createHash('sha256').update(message.raw_body).digest('hex');
  const storage_key = `data/${mailbox_id}/${checksum}`;

  const already_stored = await ctx.storage.exists(storage_key);
  if (!already_stored) {
    const ciphertext = ctx.encrypt(message.raw_body);
    await ctx.storage.put(
      storage_key,
      ciphertext,
      {
        'x-message-id': message.message_id,
        'x-plaintext-sha256': checksum,
      },
      object_lock_policy,
    );
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
