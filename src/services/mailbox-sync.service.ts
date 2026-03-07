import { inject, injectable } from 'inversify';
import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import chalk from 'chalk';
import type { TenantContextFactory } from '@/ports/tenant-context.port';
import { TENANT_CONTEXT_FACTORY_TOKEN } from '@/ports/tenant-context.port';
import type { TenantContext } from '@/ports/tenant-context.port';
import type { MailboxConnector, MailMessage, MailFolder } from '@/ports/mailbox-connector.port';
import { MAILBOX_CONNECTOR_TOKEN } from '@/ports/mailbox-connector.port';
import type { ManifestRepository } from '@/ports/manifest-repository.port';
import { MANIFEST_REPOSITORY_TOKEN } from '@/ports/manifest-repository.port';
import type { Snapshot } from '@/domain/snapshot';
import { SnapshotStatus } from '@/domain/snapshot';
import type { Manifest, ManifestEntry } from '@/domain/manifest';
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

interface FolderProgress {
  folder_name: string;
  folder_index: number;
  folder_count: number;
  folder_total_items: number;
  folder_processed: number;
  global_total_items: number;
  global_processed: number;
  started_at: number;
  folder_started_at: number;
}

@injectable()
export class MailboxSyncService {
  constructor(
    @inject(TENANT_CONTEXT_FACTORY_TOKEN) private readonly _tenant_factory: TenantContextFactory,
    @inject(MAILBOX_CONNECTOR_TOKEN) private readonly _connector: MailboxConnector,
    @inject(MANIFEST_REPOSITORY_TOKEN) private readonly _manifests: ManifestRepository,
  ) {}

  /**
   * Orchestrates a full or incremental mailbox backup across all (or filtered) folders.
   * Creates tenant infrastructure (bucket, DEK), runs delta sync per folder,
   * deduplicates via content-addressed keys, encrypts, and stores.
   */
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

    const total_folders = folders.length;
    const global_total = folders.reduce((sum, f) => sum + f.total_item_count, 0);
    logger.info(`${total_folders} folders, ~${global_total} items`);

    const all_entries: ManifestEntry[] = [];
    const new_delta_links: Record<string, string> = {};
    let global_processed = 0;
    let stored = 0;
    let deduplicated = 0;
    const folder_errors: string[] = [];
    const sync_start = Date.now();

    let folder_index = 0;
    for (const folder of folders) {
      const progress: FolderProgress = {
        folder_name: folder.display_name,
        folder_index,
        folder_count: total_folders,
        folder_total_items: folder.total_item_count,
        folder_processed: 0,
        global_total_items: global_total,
        global_processed,
        started_at: sync_start,
        folder_started_at: Date.now(),
      };

      try {
        const prev_link = saved_links[folder.folder_id];
        const result = await this.sync_single_folder(
          ctx,
          tenant_id,
          mailbox_id,
          folder.folder_id,
          progress,
          prev_link,
          previous_entry_count,
        );
        all_entries.push(...result.entries);
        new_delta_links[folder.folder_id] = result.delta_link;
        stored += result.stored;
        deduplicated += result.deduplicated;
        global_processed += progress.folder_processed;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        folder_errors.push(`${folder.display_name}: ${msg}`);
        global_processed += progress.folder_processed;
      }

      folder_index++;
    }

    logger.progress_done();

    if (folder_errors.length > 0) {
      for (const e of folder_errors) logger.warn(e);
    }

    const elapsed_s = ((Date.now() - sync_start) / 1000).toFixed(1);
    logger.info(
      `${chalk.green(String(stored))} stored, ` +
        `${chalk.yellow(String(deduplicated))} dedup, ` +
        `${chalk.red(String(folder_errors.length))} errors ` +
        `-- ${elapsed_s}s`,
    );

    const manifest = this.build_manifest(mailbox_id, snapshot.id, all_entries, new_delta_links);
    await this._manifests.save(ctx, manifest);
    const completed = this.mark_snapshot_completed(snapshot, all_entries.length);
    return { snapshot: completed, manifest };
  }

  // ---------------------------------------------------------------------------
  // Folder filtering
  // ---------------------------------------------------------------------------

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

  // ---------------------------------------------------------------------------
  // Per-folder sync
  // ---------------------------------------------------------------------------

  /**
   * Runs a delta sync for one folder with live progress on a single
   * overwriting terminal line. The on_page callback keeps the line
   * updating during delta enumeration so the UI never looks stuck.
   */
  private async sync_single_folder(
    ctx: TenantContext,
    tenant_id: string,
    mailbox_id: string,
    folder_id: string,
    progress: FolderProgress,
    prev_delta_link?: string,
    previous_manifest_entries = 0,
  ): Promise<{ entries: ManifestEntry[]; delta_link: string; stored: number; deduplicated: number }> {
    const label = `${progress.folder_name} [${progress.folder_index + 1}/${progress.folder_count}]`;

    const on_page = (_page: number, items: number): void => {
      logger.progress(`${label} -- fetching page ${_page} (${items} items)`);
    };

    let delta = await this._connector.fetch_delta(
      tenant_id, mailbox_id, folder_id, prev_delta_link, on_page,
    );

    const is_stale_delta =
      prev_delta_link &&
      delta.messages.length === 0 &&
      progress.folder_total_items > 0 &&
      previous_manifest_entries === 0;

    if (is_stale_delta) {
      logger.progress(`${label} -- stale delta, retrying full sync`);
      delta = await this._connector.fetch_delta(
        tenant_id, mailbox_id, folder_id, undefined, on_page,
      );
    }

    const entries: ManifestEntry[] = [];
    let stored = 0;
    let deduplicated = 0;

    for (const message of delta.messages) {
      const entry = await this.store_single_message(ctx, message, mailbox_id);
      if (entry.was_new) {
        stored++;
      } else {
        deduplicated++;
      }
      entries.push(entry.manifest_entry);

      progress.folder_processed++;
      progress.global_processed++;
      this.emit_progress(progress, label);
    }

    if (delta.messages.length === 0) {
      logger.progress(`${label} -- up to date`);
    }

    return { entries, delta_link: delta.delta_link, stored, deduplicated };
  }

  // ---------------------------------------------------------------------------
  // Progress display
  // ---------------------------------------------------------------------------

  /** Overwrites the terminal line with rate and ETA for the current folder. */
  private emit_progress(p: FolderProgress, label: string): void {
    const now = Date.now();
    const rate = calc_rate(p.global_processed, now - p.started_at);
    const eta = rate > 0 ? (p.global_total_items - p.global_processed) / rate : 0;

    logger.progress(
      `${label} ${p.folder_processed}/${p.folder_total_items}` +
        ` | ${rate.toFixed(1)}/s` +
        ` | ETA ${format_duration(eta)}`,
    );
  }

  // ---------------------------------------------------------------------------
  // Storage
  // ---------------------------------------------------------------------------

  /**
   * Content-addressed storage with dedup:
   *   1. SHA-256 the plaintext -> use as storage key
   *   2. Check if key already exists (dedup)
   *   3. If new: encrypt then upload
   */
  private async store_single_message(
    ctx: TenantContext,
    message: MailMessage,
    mailbox_id: string,
  ): Promise<{ manifest_entry: ManifestEntry; was_new: boolean }> {
    const checksum = this.compute_sha256(message.raw_body);
    const storage_key = this.build_content_key(mailbox_id, checksum);

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

  /** Content-addressed key: data/{mailbox_id}/{sha256_of_plaintext}. */
  private build_content_key(mailbox_id: string, checksum: string): string {
    return `data/${mailbox_id}/${checksum}`;
  }

  /** Returns the SHA-256 hex digest of the given buffer. */
  private compute_sha256(data: Buffer): string {
    return createHash('sha256').update(data).digest('hex');
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

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

  /** Assembles a complete manifest from the stored entries. */
  private build_manifest(
    mailbox_id: string,
    snapshot_id: string,
    entries: ManifestEntry[],
    delta_links: Record<string, string>,
  ): Manifest {
    const total_size_bytes = entries.reduce((sum, e) => sum + e.size_bytes, 0);
    return {
      id: randomUUID(),
      tenant_id: '',
      mailbox_id,
      snapshot_id,
      created_at: new Date(),
      total_objects: entries.length,
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

function calc_rate(processed: number, elapsed_ms: number): number {
  const s = elapsed_ms / 1000;
  return s > 0 ? processed / s : 0;
}

function format_duration(seconds: number): string {
  if (!isFinite(seconds) || seconds <= 0) return '--';
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}
