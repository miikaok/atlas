import { createHash, randomBytes } from 'node:crypto';
import { inject, injectable } from 'inversify';
import type {
  OneDriveBackupOptions,
  OneDriveBackupResult,
  OneDriveBackupUseCase,
} from '@/ports/onedrive/use-case.port';
import type { OneDriveConnector, OneDriveDeltaItem } from '@/ports/onedrive/connector.port';
import type { OneDriveManifestRepository } from '@/ports/onedrive/manifest-repository.port';
import type { OneDriveFileVersionIndexRepository } from '@/ports/onedrive/file-version-index-repository.port';
import type { OneDriveDeltaCursorRepository } from '@/ports/onedrive/delta-cursor-repository.port';
import type {
  OneDriveChangeType,
  OneDriveDeltaCursor,
  OneDriveManifestEntry,
  OneDriveSnapshotManifest,
} from '@/domain/onedrive-manifest';
import type { TenantContextFactory } from '@/ports/tenant/context.port';
import {
  ONEDRIVE_CONNECTOR_TOKEN,
  ONEDRIVE_MANIFEST_REPOSITORY_TOKEN,
  ONEDRIVE_FILE_INDEX_REPOSITORY_TOKEN,
  ONEDRIVE_DELTA_CURSOR_REPOSITORY_TOKEN,
  TENANT_CONTEXT_FACTORY_TOKEN,
} from '@/ports/tokens/outgoing.tokens';
import { onedrive_data_key } from '@/services/onedrive/onedrive-storage-keys';
import { download_with_retry } from '@/services/onedrive/onedrive-download-orchestrator';
import {
  LARGE_FILE_THRESHOLD,
  process_large_file,
  cleanup_stale_staging,
} from '@/services/onedrive/onedrive-large-file-pipeline';
import { logger } from '@/utils/logger';

@injectable()
export class OneDriveBackupService implements OneDriveBackupUseCase {
  constructor(
    @inject(TENANT_CONTEXT_FACTORY_TOKEN) private readonly _tenant_factory: TenantContextFactory,
    @inject(ONEDRIVE_CONNECTOR_TOKEN) private readonly _connector: OneDriveConnector,
    @inject(ONEDRIVE_MANIFEST_REPOSITORY_TOKEN)
    private readonly _manifests: OneDriveManifestRepository,
    @inject(ONEDRIVE_FILE_INDEX_REPOSITORY_TOKEN)
    private readonly _file_indexes: OneDriveFileVersionIndexRepository,
    @inject(ONEDRIVE_DELTA_CURSOR_REPOSITORY_TOKEN)
    private readonly _cursors: OneDriveDeltaCursorRepository,
  ) {}

  /** Backs up changed OneDrive files and creates a snapshot only when data changed. */
  async backup_onedrive(
    tenant_id: string,
    owner_id: string,
    options: OneDriveBackupOptions = {},
  ): Promise<OneDriveBackupResult> {
    const ctx = await this._tenant_factory.create(tenant_id);
    const previous_cursor =
      options.force_full === true ? undefined : await this._cursors.load(ctx, owner_id);
    const drives = await this._connector.list_drives(tenant_id, owner_id);
    ensure_drives_discovered(drives.length);
    const delta_link_by_drive: Record<string, string> = {
      ...(previous_cursor?.delta_link_by_drive ?? {}),
    };
    const previous_path_by_file_id: Record<string, string> = {
      ...(previous_cursor?.previous_path_by_file_id ?? {}),
    };
    const previous_name_by_file_id: Record<string, string> = {
      ...(previous_cursor?.previous_name_by_file_id ?? {}),
    };
    const previous_etag_by_file_id: Record<string, string> = {
      ...(previous_cursor?.previous_etag_by_file_id ?? {}),
    };

    await cleanup_stale_staging(ctx, owner_id);

    const entries: OneDriveManifestEntry[] = [];
    let files_stored = 0;
    let files_deduplicated = 0;
    let deleted_items = 0;

    for (const drive of drives) {
      const prev_delta = options.force_full
        ? undefined
        : previous_cursor?.delta_link_by_drive[drive.drive_id];
      const delta = await this._connector.fetch_delta(
        tenant_id,
        owner_id,
        drive.drive_id,
        prev_delta,
      );
      delta_link_by_drive[drive.drive_id] = delta.delta_link;

      for (const item of delta.items) {
        if (item.kind !== 'file') continue;
        const change_type = classify_change_type(
          item,
          previous_path_by_file_id,
          previous_name_by_file_id,
          previous_etag_by_file_id,
        );
        if (!change_type) continue;

        if (item.deleted) {
          deleted_items++;
          entries.push({
            file_id: item.item_id,
            drive_id: item.drive_id,
            file_name: item.file_name,
            parent_path: item.parent_path,
            web_url: item.web_url,
            size_bytes: item.size_bytes,
            backup_at: new Date().toISOString(),
            last_modified_at: item.last_modified_at,
            etag: item.etag,
            change_type,
          });
          delete previous_path_by_file_id[item.item_id];
          delete previous_name_by_file_id[item.item_id];
          delete previous_etag_by_file_id[item.item_id];
          continue;
        }

        let storage_key: string;
        let checksum: string;

        if (item.size_bytes >= LARGE_FILE_THRESHOLD) {
          try {
            const result = await process_large_file(this._connector, item, owner_id, ctx);
            storage_key = result.storage_key;
            checksum = result.checksum;
            if (result.deduplicated) files_deduplicated++;
            if (result.stored) files_stored++;
          } catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            logger.warn(`Skipping large file ${item.item_id} (${item.file_name}): ${reason}`);
            continue;
          }
        } else {
          const raw_body = await download_with_retry(this._connector, item);
          if (!raw_body) continue;
          checksum = compute_sha256_chunked(raw_body);
          storage_key = onedrive_data_key(owner_id, checksum);
          const exists = await ctx.storage.exists(storage_key);
          if (!exists) {
            await ctx.storage.put(storage_key, ctx.encrypt(raw_body), {
              'x-onedrive-file-id': item.item_id,
              'x-plaintext-sha256': checksum,
            });
            files_stored++;
          } else {
            files_deduplicated++;
          }
        }

        entries.push({
          file_id: item.item_id,
          drive_id: item.drive_id,
          file_name: item.file_name,
          parent_path: item.parent_path,
          web_url: item.web_url,
          size_bytes: item.size_bytes,
          storage_key,
          checksum,
          backup_at: new Date().toISOString(),
          last_modified_at: item.last_modified_at,
          etag: item.etag,
          change_type,
        });
        previous_path_by_file_id[item.item_id] = item.parent_path;
        previous_name_by_file_id[item.item_id] = item.file_name;
        if (item.etag) previous_etag_by_file_id[item.item_id] = item.etag;
      }
    }

    const cursor: OneDriveDeltaCursor = {
      owner_id,
      delta_link_by_drive,
      previous_path_by_file_id,
      previous_name_by_file_id,
      previous_etag_by_file_id,
      updated_at: new Date().toISOString(),
    };

    if (entries.length === 0) {
      await this._cursors.save(ctx, cursor);
      return {
        owner_id,
        snapshot: undefined,
        summary: {
          drives_scanned: drives.length,
          files_changed: 0,
          files_stored,
          files_deduplicated,
          deleted_items,
          cursor_updated: true,
          snapshot_created: false,
        },
      };
    }

    const snapshot = build_snapshot_manifest(tenant_id, owner_id, entries);
    await this._manifests.save(ctx, snapshot);

    for (const entry of entries) {
      await this._file_indexes.append_version(ctx, owner_id, entry.file_id, {
        snapshot_id: snapshot.snapshot_id,
        backup_at: entry.backup_at,
        drive_id: entry.drive_id,
        file_name: entry.file_name,
        parent_path: entry.parent_path,
        web_url: entry.web_url,
        size_bytes: entry.size_bytes,
        storage_key: entry.storage_key,
        checksum: entry.checksum,
        etag: entry.etag,
        last_modified_at: entry.last_modified_at,
        change_type: entry.change_type,
      });
    }

    await this._cursors.save(ctx, cursor);

    return {
      owner_id,
      snapshot,
      summary: {
        drives_scanned: drives.length,
        files_changed: entries.length,
        files_stored,
        files_deduplicated,
        deleted_items,
        cursor_updated: true,
        snapshot_created: true,
      },
    };
  }
}

function classify_change_type(
  item: OneDriveDeltaItem,
  previous_path_by_file_id: Record<string, string>,
  previous_name_by_file_id: Record<string, string>,
  previous_etag_by_file_id: Record<string, string>,
): OneDriveChangeType | undefined {
  if (item.deleted) return 'deleted';

  const previous_path = previous_path_by_file_id[item.item_id];
  const previous_name = previous_name_by_file_id[item.item_id];
  const previous_etag = previous_etag_by_file_id[item.item_id];
  const current_path = item.parent_path;
  const path_changed = Boolean(previous_path && previous_path !== current_path);
  const name_changed = Boolean(previous_name && previous_name !== item.file_name);
  const etag_missing_transition =
    (Boolean(previous_etag) && !item.etag) || (!previous_etag && Boolean(item.etag));
  const etag_changed = Boolean(previous_etag && item.etag && previous_etag !== item.etag);

  if (!previous_path && !previous_name && !previous_etag) return 'created';
  if (etag_missing_transition) return 'updated';
  if (etag_changed) return 'updated';
  if (path_changed) return 'moved';
  if (name_changed) return 'renamed';
  return undefined;
}

function build_snapshot_manifest(
  tenant_id: string,
  owner_id: string,
  entries: OneDriveManifestEntry[],
): OneDriveSnapshotManifest {
  const created_at = new Date();
  const snapshot_id = `od-snap-${created_at.getTime()}-${randomBytes(3).toString('hex')}`;
  return {
    id: `${owner_id}-${snapshot_id}`,
    tenant_id,
    owner_id,
    snapshot_id,
    created_at,
    total_files: entries.length,
    total_size_bytes: entries.reduce((sum, entry) => sum + entry.size_bytes, 0),
    entries,
  };
}

function ensure_drives_discovered(drive_count: number): void {
  if (drive_count > 0) return;
  throw new Error(
    'Missing Microsoft Graph application permissions for OneDrive: Files.Read.All, Sites.Read.All.',
  );
}

const HASH_CHUNK_SIZE = 64 * 1024 * 1024;

/** Computes SHA-256 in chunks to avoid ERR_OUT_OF_RANGE on buffers > 2 GB. */
function compute_sha256_chunked(data: Buffer): string {
  const hash = createHash('sha256');
  for (let offset = 0; offset < data.length; offset += HASH_CHUNK_SIZE) {
    hash.update(data.subarray(offset, Math.min(offset + HASH_CHUNK_SIZE, data.length)));
  }
  return hash.digest('hex');
}
