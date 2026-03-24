import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OneDriveCatalogService } from '@/services/onedrive/onedrive-catalog.service';
import type { OneDriveManifestRepository } from '@/ports/onedrive/manifest-repository.port';
import type { OneDriveFileVersionIndexRepository } from '@/ports/onedrive/file-version-index-repository.port';
import type { TenantContextFactory } from '@/ports/tenant/context.port';

describe('OneDriveCatalogService', () => {
  const tenant_factory: TenantContextFactory = {
    create: vi.fn().mockResolvedValue({
      tenant_id: 'tenant-1',
      storage: {},
      encrypt: vi.fn(),
      decrypt: vi.fn(),
    }),
  } as unknown as TenantContextFactory;

  let manifests: OneDriveManifestRepository;
  let indexes: OneDriveFileVersionIndexRepository;
  let service: OneDriveCatalogService;

  beforeEach(() => {
    manifests = {
      save: vi.fn(),
      find_by_snapshot: vi.fn(),
      find_latest_by_owner: vi.fn(),
      list_snapshots_by_owner: vi.fn().mockResolvedValue([]),
    };
    indexes = {
      find_by_file_id: vi.fn(),
      append_version: vi.fn(),
      list_by_owner: vi.fn().mockResolvedValue([]),
    };
    service = new OneDriveCatalogService(tenant_factory, manifests, indexes);
  });

  it('lists snapshots by owner', async () => {
    vi.mocked(manifests.list_snapshots_by_owner).mockResolvedValue([
      {
        id: 'owner-snap-1',
        tenant_id: 'tenant-1',
        owner_id: 'owner@test.com',
        snapshot_id: 'snap-1',
        created_at: new Date('2026-03-24T00:00:00.000Z'),
        total_files: 1,
        total_size_bytes: 1,
        entries: [],
      },
    ]);

    const snapshots = await service.list_onedrive_snapshots('tenant-1', 'owner@test.com');
    expect(snapshots).toHaveLength(1);
    expect(manifests.list_snapshots_by_owner).toHaveBeenCalled();
  });

  it('resolves file versions by direct file id lookup', async () => {
    vi.mocked(indexes.find_by_file_id).mockResolvedValue({
      file_id: 'f1',
      owner_id: 'owner@test.com',
      versions: [
        {
          snapshot_id: 'snap-1',
          backup_at: '2026-03-24T01:00:00.000Z',
          drive_id: 'd1',
          file_name: 'a.txt',
          parent_path: '/docs',
          size_bytes: 10,
          change_type: 'created',
        },
      ],
    });

    const versions = await service.list_onedrive_file_versions('tenant-1', 'owner@test.com', 'f1');
    expect(versions).toHaveLength(1);
  });

  it('resolves file versions by path reference when file id lookup misses', async () => {
    vi.mocked(indexes.list_by_owner).mockResolvedValue([
      {
        file_id: 'f1',
        owner_id: 'owner@test.com',
        versions: [
          {
            snapshot_id: 'snap-1',
            backup_at: '2026-03-24T01:00:00.000Z',
            drive_id: 'd1',
            file_name: 'a.txt',
            parent_path: '/docs',
            size_bytes: 10,
            change_type: 'created',
          },
        ],
      },
    ]);

    const versions = await service.list_onedrive_file_versions(
      'tenant-1',
      'owner@test.com',
      '/docs/a.txt',
    );
    expect(versions).toHaveLength(1);
    expect(indexes.find_by_file_id).not.toHaveBeenCalled();
    expect(indexes.list_by_owner).toHaveBeenCalled();
  });
});
