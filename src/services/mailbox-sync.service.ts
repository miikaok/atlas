import { inject, injectable } from 'inversify';
import { createHash, randomUUID } from 'node:crypto';
import chalk from 'chalk';
import type { TenantContextFactory, TenantContext } from '@/ports/tenant-context.port';
import { TENANT_CONTEXT_FACTORY_TOKEN } from '@/ports/tenant-context.port';
import type { MailboxConnector, MailMessage, MailFolder } from '@/ports/mailbox-connector.port';
import { MAILBOX_CONNECTOR_TOKEN } from '@/ports/mailbox-connector.port';
import type { ManifestRepository } from '@/ports/manifest-repository.port';
import { MANIFEST_REPOSITORY_TOKEN } from '@/ports/manifest-repository.port';
import type { Snapshot } from '@/domain/snapshot';
import { SnapshotStatus } from '@/domain/snapshot';
import type { Manifest, ManifestEntry } from '@/domain/manifest';
import { fetch_and_store_attachments } from '@/services/attachment-sync.helper';
import { calc_rate } from '@/services/sync-progress.helper';
import { BackupDashboard } from '@/services/backup-dashboard';
import { logger } from '@/utils/logger';

export interface SyncResult {
  readonly snapshot: Snapshot;
  readonly manifest: Manifest;
}

export interface SyncOptions {
  readonly folder_filter?: string[] | undefined;
  /** When true, ignores saved delta links and performs a full enumeration of every folder. */
  readonly force_full?: boolean | undefined;
}

@injectable()
export class MailboxSyncService {
  constructor(
    @inject(TENANT_CONTEXT_FACTORY_TOKEN) private readonly _tenant_factory: TenantContextFactory,
    @inject(MAILBOX_CONNECTOR_TOKEN) private readonly _connector: MailboxConnector,
    @inject(MANIFEST_REPOSITORY_TOKEN) private readonly _manifests: ManifestRepository,
  ) {}

  /** Orchestrates a full or incremental mailbox backup across all (or filtered) folders. */
  async sync_mailbox(
    tenant_id: string,
    mailbox_id: string,
    options: SyncOptions = {},
  ): Promise<SyncResult> {
    mailbox_id = mailbox_id.toLowerCase();
    const ctx = await this._tenant_factory.create(tenant_id);
    const snapshot = this.create_pending_snapshot(tenant_id, mailbox_id);

    const previous = options.force_full
      ? undefined
      : await this._manifests.find_latest_by_mailbox(ctx, mailbox_id);
    const saved_links = previous?.delta_links ?? {};
    const previous_entry_count = previous?.total_objects ?? 0;

    if (options.force_full) {
      logger.info(chalk.yellow('Full sync forced – ignoring saved delta state'));
    } else if (Object.keys(saved_links).length > 0) {
      logger.info(
        `Resuming incremental sync (${Object.keys(saved_links).length} saved delta links, ` +
          `${previous_entry_count} objects in prior backup)`,
      );
    } else {
      logger.info('No prior backup found – running initial full sync');
    }

    const all_folders = await this._connector.list_mail_folders(tenant_id, mailbox_id);
    const folders = this.apply_folder_filter(all_folders, options.folder_filter);
    const global_total = folders.reduce((sum, f) => sum + f.total_item_count, 0);
    logger.info(`${folders.length} folders, ~${global_total} items`);

    const dashboard = new BackupDashboard(
      folders.map((f) => ({ name: f.display_name, total_items: f.total_item_count })),
    );

    const all_entries: ManifestEntry[] = [];
    const new_delta_links: Record<string, string> = {};
    let global_processed = 0, stored = 0, deduplicated = 0, attachments_stored = 0;
    const folder_errors: string[] = [];
    const sync_start = Date.now();

    for (let i = 0; i < folders.length; i++) {
      const folder = folders[i]!;
      dashboard.mark_active(i);

      let f_stored = 0, f_deduped = 0, f_att = 0;
      try {
        const prev_link = saved_links[folder.folder_id];
        const result = await this.sync_single_folder(
          ctx, tenant_id, mailbox_id, folder.folder_id, i,
          folder.total_item_count, global_total, global_processed, sync_start,
          dashboard, prev_link, previous_entry_count,
        );
        all_entries.push(...result.entries);
        new_delta_links[folder.folder_id] = result.delta_link;
        f_stored = result.stored;
        f_deduped = result.deduplicated;
        f_att = result.attachments_stored;
        stored += f_stored;
        deduplicated += f_deduped;
        attachments_stored += f_att;
        global_processed += result.folder_processed;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        folder_errors.push(`${folder.display_name}: ${msg}`);
        dashboard.mark_error(i, msg);
        continue;
      }

      const rate = calc_rate(global_processed, Date.now() - sync_start);
      const eta = rate > 0 ? (global_total - global_processed) / rate : 0;
      dashboard.update_total(global_processed, global_total, rate, eta);
      dashboard.mark_done(i, f_stored, f_deduped, f_att);
    }

    dashboard.finish(global_processed);
    if (folder_errors.length > 0) {
      for (const e of folder_errors) logger.warn(e);
    }

    const elapsed_s = ((Date.now() - sync_start) / 1000).toFixed(1);
    logger.info(
      `${chalk.green(String(stored))} stored, ` +
        `${chalk.yellow(String(deduplicated))} dedup, ` +
        `${chalk.cyan(String(attachments_stored))} attachments, ` +
        `${chalk.red(String(folder_errors.length))} errors ` +
        `-- ${elapsed_s}s`,
    );

    const manifest = this.build_manifest(
      mailbox_id, snapshot.id, all_entries, new_delta_links, previous_entry_count,
    );
    await this._manifests.save(ctx, manifest);
    const completed = this.mark_snapshot_completed(snapshot, all_entries.length);
    return { snapshot: completed, manifest };
  }

  /**
   * Filters the full folder list by display name (case-insensitive).
   * Returns all folders if no filter is specified.
   */
  private apply_folder_filter(folders: MailFolder[], filter?: string[]): MailFolder[] {
    if (!filter || filter.length === 0) return folders;

    const lower_filter = new Set(filter.map((f) => f.toLowerCase()));
    const matched = folders.filter((f) => lower_filter.has(f.display_name.toLowerCase()));
    const matched_names = new Set(matched.map((f) => f.display_name.toLowerCase()));

    for (const name of lower_filter) {
      if (!matched_names.has(name)) {
        const available = folders.map((f) => f.display_name).join(', ');
        logger.warn(`Folder "${name}" not found. Available: ${available}`);
      }
    }

    return matched;
  }

  /** Runs a delta sync for one folder, driving the dashboard for live progress. */
  private async sync_single_folder(
    ctx: TenantContext,
    tenant_id: string,
    mailbox_id: string,
    folder_id: string,
    folder_index: number,
    folder_total: number,
    global_total: number,
    global_processed_before: number,
    sync_start: number,
    dashboard: BackupDashboard,
    prev_delta_link?: string,
    previous_manifest_entries = 0,
  ): Promise<{
    entries: ManifestEntry[];
    delta_link: string;
    stored: number;
    deduplicated: number;
    attachments_stored: number;
    folder_processed: number;
  }> {
    const page_start = Date.now();

    const on_page = (_page: number, items: number): void => {
      const elapsed_ms = Date.now() - page_start;
      const page_rate = calc_rate(items, elapsed_ms);
      const remaining = global_total - global_processed_before - items;
      const eta = page_rate > 0 ? remaining / page_rate : 0;
      dashboard.update_paging(folder_index, items, page_rate, eta);
      dashboard.update_total(global_processed_before, global_total, page_rate, eta);
    };

    let delta = await this._connector.fetch_delta(
      tenant_id, mailbox_id, folder_id, prev_delta_link, on_page,
    );

    if (prev_delta_link && delta.messages.length === 0 && folder_total > 0 && previous_manifest_entries === 0) {
      delta = await this._connector.fetch_delta(
        tenant_id, mailbox_id, folder_id, undefined, on_page,
      );
    }

    const entries: ManifestEntry[] = [];
    let stored = 0, deduplicated = 0, att_stored = 0, folder_processed = 0;

    for (const message of delta.messages) {
      const entry = await this.store_single_message(ctx, message, mailbox_id);
      if (entry.was_new) stored++;
      else deduplicated++;

      const attachment_entries = message.has_attachments
        ? await fetch_and_store_attachments(
            ctx, this._connector, tenant_id, mailbox_id, message.message_id,
          )
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
      entries, delta_link: delta.delta_link,
      stored, deduplicated, attachments_stored: att_stored, folder_processed,
    };
  }

  /** Content-addressed storage with SHA-256 dedup: hash -> check exists -> encrypt -> upload. */
  private async store_single_message(
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
    };

    return { manifest_entry, was_new: !already_stored };
  }

  /** Creates a snapshot record in IN_PROGRESS state. */
  private create_pending_snapshot(tenant_id: string, mailbox_id: string): Snapshot {
    return {
      id: randomUUID(),
      tenant_id,
      mailbox_id,
      started_at: new Date(),
      object_count: 0,
      status: SnapshotStatus.IN_PROGRESS,
    };
  }

  /**
   * Assembles a complete manifest. When the current sync found no new entries,
   * carries forward the prior backup's total_objects so the stale-delta
   * safeguard does not mistake an unchanged mailbox for a never-backed-up one.
   */
  private build_manifest(
    mailbox_id: string,
    snapshot_id: string,
    entries: ManifestEntry[],
    delta_links: Record<string, string>,
    previous_total_objects = 0,
  ): Manifest {
    const total_size_bytes = entries.reduce((sum, e) => {
      const att_size = e.attachments?.reduce((a, att) => a + att.size_bytes, 0) ?? 0;
      return sum + e.size_bytes + att_size;
    }, 0);
    return {
      id: randomUUID(),
      tenant_id: '',
      mailbox_id,
      snapshot_id,
      created_at: new Date(),
      total_objects: Math.max(entries.length, previous_total_objects),
      total_size_bytes,
      delta_links,
      entries,
    };
  }

  /** Returns a copy of the snapshot marked as COMPLETED with final counts. */
  private mark_snapshot_completed(snapshot: Snapshot, object_count: number): Snapshot {
    return {
      ...snapshot,
      completed_at: new Date(),
      object_count,
      status: SnapshotStatus.COMPLETED,
    };
  }
}
