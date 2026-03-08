import { inject, injectable } from 'inversify';
import chalk from 'chalk';
import type { TenantContextFactory } from '@/ports/tenant-context.port';
import { TENANT_CONTEXT_FACTORY_TOKEN } from '@/ports/tenant-context.port';
import type { MailboxConnector, MailFolder } from '@/ports/mailbox-connector.port';
import { MAILBOX_CONNECTOR_TOKEN } from '@/ports/mailbox-connector.port';
import type { ManifestRepository } from '@/ports/manifest-repository.port';
import { MANIFEST_REPOSITORY_TOKEN } from '@/ports/manifest-repository.port';
import type { ManifestEntry } from '@/domain/manifest';
import { calc_rate } from '@/services/sync-progress.helper';
import { BackupDashboard } from '@/services/backup-dashboard';
import { sync_single_folder } from '@/services/sync-folder.helper';
import {
  build_manifest,
  create_pending_snapshot,
  mark_snapshot_completed,
} from '@/services/sync-manifest.helper';
import { logger } from '@/utils/logger';
import type { Snapshot } from '@/domain/snapshot';
import type { Manifest } from '@/domain/manifest';

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
  private _interrupted = false;

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
    const snapshot = create_pending_snapshot(tenant_id, mailbox_id);

    const previous = options.force_full
      ? undefined
      : await this._manifests.find_latest_by_mailbox(ctx, mailbox_id);
    const saved_links = previous?.delta_links ?? {};
    const previous_entry_count = previous?.total_objects ?? 0;

    this.log_sync_mode(options, saved_links, previous_entry_count);

    const all_folders = await this._connector.list_mail_folders(tenant_id, mailbox_id);
    const folders = this.apply_folder_filter(all_folders, options.folder_filter);
    const global_total = folders.reduce((sum, f) => sum + f.total_item_count, 0);
    logger.info(`${folders.length} folders, ~${global_total} items`);

    const dashboard = new BackupDashboard(
      folders.map((f) => ({ name: f.display_name, total_items: f.total_item_count })),
    );

    const all_entries: ManifestEntry[] = [];
    const new_delta_links: Record<string, string> = {};
    let global_processed = 0,
      stored = 0,
      deduplicated = 0,
      attachments_stored = 0;
    const folder_errors: string[] = [];
    const sync_start = Date.now();

    this._interrupted = false;
    const on_sigint = (): void => {
      this._interrupted = true;
    };
    process.on('SIGINT', on_sigint);

    try {
      for (let i = 0; i < folders.length; i++) {
        if (this._interrupted) break;
        const folder = folders[i]!;
        dashboard.mark_active(i);

        let f_stored = 0,
          f_deduped = 0,
          f_att = 0;
        try {
          const prev_link = saved_links[folder.folder_id];
          const result = await sync_single_folder({
            ctx,
            connector: this._connector,
            tenant_id,
            mailbox_id,
            folder_id: folder.folder_id,
            folder_index: i,
            folder_total: folder.total_item_count,
            global_total,
            global_processed_before: global_processed,
            sync_start,
            dashboard,
            is_interrupted: () => this._interrupted,
            prev_delta_link: prev_link,
            previous_manifest_entries: previous_entry_count,
          });
          all_entries.push(...result.entries);
          if (!this._interrupted) {
            new_delta_links[folder.folder_id] = result.delta_link;
          }
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

        if (this._interrupted) break;

        const rate = calc_rate(global_processed, Date.now() - sync_start);
        const eta = rate > 0 ? (global_total - global_processed) / rate : 0;
        dashboard.update_total(global_processed, global_total, rate, eta);
        dashboard.mark_done(i, f_stored, f_deduped, f_att);
      }

      if (this._interrupted) dashboard.mark_all_pending_interrupted();
      dashboard.finish(global_processed);
      if (folder_errors.length > 0) {
        for (const e of folder_errors) logger.warn(e);
      }

      this.log_summary(stored, deduplicated, attachments_stored, folder_errors.length, sync_start);

      const merged_links = { ...saved_links, ...new_delta_links };
      const manifest = build_manifest(
        mailbox_id,
        snapshot.id,
        all_entries,
        merged_links,
        previous_entry_count,
      );
      await this._manifests.save(ctx, manifest);

      if (this._interrupted) {
        const done_count = Object.keys(new_delta_links).length;
        logger.warn(
          chalk.yellow(
            `Interrupted -- progress saved (${done_count}/${folders.length} folders, ${global_processed} items)`,
          ),
        );
      }

      const completed = mark_snapshot_completed(snapshot, all_entries.length);
      return { snapshot: completed, manifest };
    } finally {
      process.removeListener('SIGINT', on_sigint);
    }
  }

  /** Logs which sync mode is being used (full, incremental, or initial). */
  private log_sync_mode(
    options: SyncOptions,
    saved_links: Record<string, string>,
    previous_entry_count: number,
  ): void {
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
  }

  /** Prints a summary line after the folder loop finishes. */
  private log_summary(
    stored: number,
    deduplicated: number,
    attachments_stored: number,
    error_count: number,
    sync_start: number,
  ): void {
    const elapsed_s = ((Date.now() - sync_start) / 1000).toFixed(1);
    logger.info(
      `${chalk.green(String(stored))} stored, ` +
        `${chalk.yellow(String(deduplicated))} dedup, ` +
        `${chalk.cyan(String(attachments_stored))} attachments, ` +
        `${chalk.red(String(error_count))} errors ` +
        `-- ${elapsed_s}s`,
    );
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
}
