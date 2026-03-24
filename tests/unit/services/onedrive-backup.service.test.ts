import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OneDriveBackupService } from '@/services/onedrive/onedrive-backup.service';
import type { OneDriveConnector } from '@/ports/onedrive/connector.port';
import type { OneDriveManifestRepository } from '@/ports/onedrive/manifest-repository.port';
import type { OneDriveFileVersionIndexRepository } from '@/ports/onedrive/file-version-index-repository.port';
import type { OneDriveDeltaCursorRepository } from '@/ports/onedrive/delta-cursor-repository.port';
import type { TenantContext, TenantContextFactory } from '@/ports/tenant/context.port';
import type { ObjectStorage } from '@/ports/storage/object-storage.port';

function make_storage(): ObjectStorage {
  return {
    put: vi.fn(),
    get: vi.fn(),
    delete: vi.fn(),
    delete_version: vi.fn(),
    exists: vi.fn().mockResolvedValue(false),
    list: vi.fn().mockResolvedValue([]),
    list_versions: vi.fn().mockResolvedValue([]),
    probe_immutability: vi.fn().mockResolvedValue({
      bucket: 'atlas-tenant',
      reachable: true,
      versioning_enabled: true,
      object_lock_enabled: true,
      mode_supported: true,
    }),
  };
}

describe('OneDriveBackupService', () => {
  let storage: ObjectStorage;
  let context: TenantContext;
  let tenant_factory: TenantContextFactory;
  let connector: OneDriveConnector;
  let manifests: OneDriveManifestRepository;
  let indexes: OneDriveFileVersionIndexRepository;
  let cursors: OneDriveDeltaCursorRepository;
  let service: OneDriveBackupService;

  beforeEach(() => {
    storage = make_storage();
    context = {
      tenant_id: 'tenant-1',
      storage,
      encrypt: vi.fn((data: Buffer) => data),
      decrypt: vi.fn((data: Buffer) => data),
    };

    tenant_factory = { create: vi.fn().mockResolvedValue(context) };
    connector = {
      list_drives: vi.fn().mockResolvedValue([{ drive_id: 'd1', drive_name: 'Drive 1' }]),
      fetch_delta: vi.fn(),
      download_file_content: vi.fn().mockResolvedValue(Buffer.from('file-body')),
    };
    manifests = {
      save: vi.fn(),
      find_by_snapshot: vi.fn(),
      find_latest_by_owner: vi.fn(),
      list_snapshots_by_owner: vi.fn(),
    };
    indexes = {
      find_by_file_id: vi.fn(),
      append_version: vi.fn().mockResolvedValue({ file_id: 'f1', owner_id: 'owner', versions: [] }),
      list_by_owner: vi.fn(),
    };
    cursors = {
      load: vi.fn(),
      save: vi.fn(),
    };

    service = new OneDriveBackupService(tenant_factory, connector, manifests, indexes, cursors);
  });

  it('skips snapshot creation when no changed items are detected', async () => {
    vi.mocked(cursors.load).mockResolvedValue({
      owner_id: 'owner@test.com',
      delta_link_by_drive: { d1: 'delta-prev' },
      previous_path_by_file_id: { f1: '/docs' },
      previous_name_by_file_id: { f1: 'a.txt' },
      previous_etag_by_file_id: { f1: 'etag-1' },
      updated_at: new Date().toISOString(),
    });
    vi.mocked(connector.fetch_delta).mockResolvedValue({
      drive_id: 'd1',
      delta_link: 'delta-next',
      reset_detected: false,
      items: [
        {
          item_id: 'f1',
          drive_id: 'd1',
          kind: 'file',
          file_name: 'a.txt',
          parent_path: '/docs',
          size_bytes: 10,
          etag: 'etag-1',
          deleted: false,
          download_url: 'https://download.example/a',
        },
      ],
    });

    const result = await service.backup_onedrive('tenant-1', 'owner@test.com');

    expect(result.snapshot).toBeUndefined();
    expect(result.summary.snapshot_created).toBe(false);
    expect(cursors.save).toHaveBeenCalledOnce();
    expect(manifests.save).not.toHaveBeenCalled();
    expect(indexes.append_version).not.toHaveBeenCalled();
  });

  it('stores changed files and writes snapshot + version index', async () => {
    vi.mocked(cursors.load).mockResolvedValue(undefined);
    vi.mocked(connector.fetch_delta).mockResolvedValue({
      drive_id: 'd1',
      delta_link: 'delta-next',
      reset_detected: false,
      items: [
        {
          item_id: 'f1',
          drive_id: 'd1',
          kind: 'file',
          file_name: 'a.txt',
          parent_path: '/docs',
          size_bytes: 10,
          etag: 'etag-1',
          deleted: false,
          download_url: 'https://download.example/a',
        },
      ],
    });

    const result = await service.backup_onedrive('tenant-1', 'owner@test.com');

    expect(result.snapshot?.total_files).toBe(1);
    expect(manifests.save).toHaveBeenCalledOnce();
    expect(indexes.append_version).toHaveBeenCalledOnce();
    expect(storage.put).toHaveBeenCalled();
  });

  it('records deleted items as snapshot entries without blob upload', async () => {
    vi.mocked(cursors.load).mockResolvedValue(undefined);
    vi.mocked(connector.fetch_delta).mockResolvedValue({
      drive_id: 'd1',
      delta_link: 'delta-next',
      reset_detected: false,
      items: [
        {
          item_id: 'f1',
          drive_id: 'd1',
          kind: 'file',
          file_name: 'a.txt',
          parent_path: '/docs',
          size_bytes: 10,
          deleted: true,
        },
      ],
    });

    const result = await service.backup_onedrive('tenant-1', 'owner@test.com');

    expect(result.snapshot?.entries[0]?.change_type).toBe('deleted');
    expect(connector.download_file_content).not.toHaveBeenCalled();
    expect(indexes.append_version).toHaveBeenCalledOnce();
  });

  it('fails with actionable error when no drives are discoverable', async () => {
    vi.mocked(connector.list_drives).mockResolvedValue([]);
    await expect(service.backup_onedrive('tenant-1', 'owner@test.com')).rejects.toThrow(
      /Files\.Read\.All, Sites\.Read\.All/,
    );
  });

  it('skips files that fail to download and continues backup run', async () => {
    vi.mocked(cursors.load).mockResolvedValue(undefined);
    vi.mocked(connector.fetch_delta).mockResolvedValue({
      drive_id: 'd1',
      delta_link: 'delta-next',
      reset_detected: false,
      items: [
        {
          item_id: 'f1',
          drive_id: 'd1',
          kind: 'file',
          file_name: 'broken.bin',
          parent_path: '/docs',
          size_bytes: 10,
          etag: 'etag-1',
          deleted: false,
          download_url: 'https://download.example/broken',
        },
      ],
    });
    vi.mocked(connector.download_file_content).mockRejectedValue(new Error('stream timed out'));

    const result = await service.backup_onedrive('tenant-1', 'owner@test.com');
    expect(result.snapshot).toBeUndefined();
    expect(result.summary.snapshot_created).toBe(false);
    expect(cursors.save).toHaveBeenCalledOnce();
  });
});
