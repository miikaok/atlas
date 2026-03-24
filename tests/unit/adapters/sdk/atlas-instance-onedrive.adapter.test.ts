/* eslint-disable @typescript-eslint/naming-convention */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AtlasInstanceConfig } from '@/ports/atlas/use-case.port';
import type {
  OneDriveBackupUseCase,
  OneDriveCatalogUseCase,
  OneDriveVerificationUseCase,
} from '@/ports/onedrive/use-case.port';

const TENANT_ID = 'test-tenant-id';
const VALID_CONFIG: AtlasInstanceConfig = {
  tenantId: TENANT_ID,
  clientId: 'cid',
  clientSecret: 'csecret',
  s3Endpoint: 'http://localhost:9000',
  s3AccessKey: 'ak',
  s3SecretKey: 'sk',
  encryptionPassphrase: 'passphrase',
};

const mock_onedrive_backup: OneDriveBackupUseCase = { backup_onedrive: vi.fn() };
const mock_onedrive_catalog: OneDriveCatalogUseCase = {
  list_onedrive_snapshots: vi.fn(),
  list_onedrive_file_versions: vi.fn(),
};
const mock_onedrive_verify: OneDriveVerificationUseCase = { verify_onedrive_snapshot: vi.fn() };

vi.mock('@/container', () => ({
  create_container_from_config: vi.fn(() => ({
    get: vi.fn((token: symbol) => {
      const map: Record<string, unknown> = {
        BackupUseCase: { sync_mailbox: vi.fn() },
        VerificationUseCase: { verify_snapshot_integrity: vi.fn() },
        RestoreUseCase: { restore_snapshot: vi.fn(), restore_mailbox: vi.fn() },
        CatalogUseCase: {
          list_mailboxes: vi.fn(),
          list_snapshots: vi.fn(),
          get_snapshot_detail: vi.fn(),
          read_message: vi.fn(),
        },
        DeletionUseCase: { delete_mailbox_data: vi.fn(), delete_snapshot: vi.fn() },
        StorageCheckUseCase: { check_storage: vi.fn() },
        SaveUseCase: { save_snapshot: vi.fn(), save_mailbox: vi.fn() },
        StatsUseCase: { get_bucket_stats: vi.fn(), get_mailbox_stats: vi.fn() },
        StatusUseCase: { check_mailbox_status: vi.fn() },
        OneDriveBackupUseCase: mock_onedrive_backup,
        OneDriveCatalogUseCase: mock_onedrive_catalog,
        OneDriveVerificationUseCase: mock_onedrive_verify,
      };
      return map[token.description ?? ''];
    }),
  })),
}));

describe('createAtlasInstance OneDrive methods', () => {
  let createAtlasInstance: (config: AtlasInstanceConfig) => {
    backupOneDrive: (owner_id: string, options?: { force_full?: boolean }) => Promise<unknown>;
    listOneDriveFileVersions: (owner_id: string, file_ref: string) => Promise<unknown>;
    verifyOneDriveSnapshot: (snapshot_id: string) => Promise<unknown>;
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    const mod = await import('@/adapters/sdk/atlas-instance.adapter');
    createAtlasInstance = mod.createAtlasInstance;
  });

  it('delegates backupOneDrive with bound tenant', async () => {
    vi.mocked(mock_onedrive_backup.backup_onedrive).mockResolvedValue({
      owner_id: 'owner@test.com',
      snapshot: undefined,
      summary: {
        drives_scanned: 1,
        files_changed: 0,
        files_stored: 0,
        files_deduplicated: 0,
        deleted_items: 0,
        cursor_updated: true,
        snapshot_created: false,
      },
    });
    const atlas = createAtlasInstance(VALID_CONFIG);
    await atlas.backupOneDrive('owner@test.com', { force_full: true });

    expect(mock_onedrive_backup.backup_onedrive).toHaveBeenCalledWith(TENANT_ID, 'owner@test.com', {
      force_full: true,
    });
  });

  it('delegates listOneDriveFileVersions with bound tenant', async () => {
    vi.mocked(mock_onedrive_catalog.list_onedrive_file_versions).mockResolvedValue([]);
    const atlas = createAtlasInstance(VALID_CONFIG);
    await atlas.listOneDriveFileVersions('owner@test.com', '/docs/a.txt');

    expect(mock_onedrive_catalog.list_onedrive_file_versions).toHaveBeenCalledWith(
      TENANT_ID,
      'owner@test.com',
      '/docs/a.txt',
    );
  });

  it('delegates verifyOneDriveSnapshot with bound tenant', async () => {
    vi.mocked(mock_onedrive_verify.verify_onedrive_snapshot).mockResolvedValue({
      snapshot_id: 'snap-1',
      total_checked: 1,
      passed: 1,
      failed_file_ids: [],
      index_issues: [],
    });
    const atlas = createAtlasInstance(VALID_CONFIG);
    await atlas.verifyOneDriveSnapshot('snap-1');

    expect(mock_onedrive_verify.verify_onedrive_snapshot).toHaveBeenCalledWith(TENANT_ID, 'snap-1');
  });
});
