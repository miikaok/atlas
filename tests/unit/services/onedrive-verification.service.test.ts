import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { OneDriveVerificationService } from '@/services/onedrive/onedrive-verification.service';
import type { OneDriveManifestRepository } from '@/ports/onedrive/manifest-repository.port';
import type { OneDriveFileVersionIndexRepository } from '@/ports/onedrive/file-version-index-repository.port';
import type { TenantContextFactory } from '@/ports/tenant/context.port';

describe('OneDriveVerificationService', () => {
  let manifests: OneDriveManifestRepository;
  let indexes: OneDriveFileVersionIndexRepository;
  let service: OneDriveVerificationService;
  const plaintext = Buffer.from('hello');
  const checksum = createHash('sha256').update(plaintext).digest('hex');

  const tenant_factory: TenantContextFactory = {
    create: vi.fn().mockResolvedValue({
      tenant_id: 'tenant-1',
      storage: {
        exists: vi.fn().mockResolvedValue(true),
        get: vi.fn().mockResolvedValue(plaintext),
      },
      encrypt: vi.fn((data: Buffer) => data),
      decrypt: vi.fn((data: Buffer) => data),
    }),
  } as unknown as TenantContextFactory;

  beforeEach(() => {
    manifests = {
      save: vi.fn(),
      find_by_snapshot: vi.fn(),
      find_latest_by_owner: vi.fn(),
      list_snapshots_by_owner: vi.fn(),
    };
    indexes = {
      find_by_file_id: vi.fn(),
      append_version: vi.fn(),
      list_by_owner: vi.fn(),
    };
    service = new OneDriveVerificationService(tenant_factory, manifests, indexes);
  });

  it('passes when blob and index checks succeed', async () => {
    vi.mocked(manifests.find_by_snapshot).mockResolvedValue({
      id: 'owner-snap-1',
      tenant_id: 'tenant-1',
      owner_id: 'owner@test.com',
      snapshot_id: 'snap-1',
      created_at: new Date(),
      total_files: 1,
      total_size_bytes: 1,
      entries: [
        {
          file_id: 'f1',
          drive_id: 'd1',
          file_name: 'a.txt',
          parent_path: '/docs',
          size_bytes: 5,
          storage_key: 'onedrive/data/o/checksum',
          checksum,
          backup_at: new Date().toISOString(),
          change_type: 'created',
        },
      ],
    });
    vi.mocked(indexes.find_by_file_id).mockResolvedValue({
      file_id: 'f1',
      owner_id: 'owner@test.com',
      versions: [
        {
          snapshot_id: 'snap-1',
          backup_at: new Date().toISOString(),
          drive_id: 'd1',
          file_name: 'a.txt',
          parent_path: '/docs',
          size_bytes: 5,
          storage_key: 'onedrive/data/o/checksum',
          checksum,
          change_type: 'created',
        },
      ],
    });

    const result = await service.verify_onedrive_snapshot('tenant-1', 'snap-1');
    expect(result.failed_file_ids).toEqual([]);
    expect(result.index_issues).toEqual([]);
  });

  it('reports blob mismatch and missing index issues', async () => {
    vi.mocked(manifests.find_by_snapshot).mockResolvedValue({
      id: 'owner-snap-1',
      tenant_id: 'tenant-1',
      owner_id: 'owner@test.com',
      snapshot_id: 'snap-1',
      created_at: new Date(),
      total_files: 1,
      total_size_bytes: 1,
      entries: [
        {
          file_id: 'f1',
          drive_id: 'd1',
          file_name: 'a.txt',
          parent_path: '/docs',
          size_bytes: 5,
          storage_key: 'onedrive/data/o/checksum',
          checksum: 'bad',
          backup_at: new Date().toISOString(),
          change_type: 'created',
        },
      ],
    });
    vi.mocked(indexes.find_by_file_id).mockResolvedValue(undefined);

    const result = await service.verify_onedrive_snapshot('tenant-1', 'snap-1');
    expect(result.failed_file_ids).toEqual(['f1']);
    expect(result.index_issues[0]).toContain('missing index');
  });
});
