import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  process_large_file,
  cleanup_stale_staging,
} from '@/services/onedrive/onedrive-large-file-pipeline';
import type { OneDriveConnector, OneDriveDeltaItem } from '@/ports/onedrive/connector.port';
import type { TenantContext } from '@/ports/tenant/context.port';
import type { MultipartUploadHandle, ObjectStorage } from '@/ports/storage/object-storage.port';

vi.mock('@/adapters/m365/graph-onedrive-chunk-fetcher', () => ({
  fetch_file_chunks: async function* (_url: string, total: number) {
    const chunk_size = 4 * 1024 * 1024;
    let remaining = total;
    while (remaining > 0) {
      const size = Math.min(chunk_size, remaining);
      yield Buffer.alloc(size, 0xab);
      remaining -= size;
    }
  },
}));

function make_item(overrides?: Partial<OneDriveDeltaItem>): OneDriveDeltaItem {
  return {
    item_id: 'file-1',
    drive_id: 'drive-1',
    kind: 'file',
    file_name: 'large-report.zip',
    parent_path: '/docs',
    size_bytes: 600 * 1024 * 1024,
    deleted: false,
    download_url: 'https://dl.example/large-file',
    ...overrides,
  };
}

function make_handle(): MultipartUploadHandle & { _calls: string[] } {
  const calls: string[] = [];
  return {
    _calls: calls,
    upload_part: vi.fn(async (part_number: number) => {
      calls.push(`upload_part:${part_number}`);
      return `"etag-${part_number}"`;
    }),
    complete: vi.fn(async () => {
      calls.push('complete');
    }),
    abort: vi.fn(async () => {
      calls.push('abort');
    }),
  };
}

function make_storage(handle: MultipartUploadHandle): ObjectStorage {
  return {
    put: vi.fn().mockResolvedValue(undefined),
    get: vi.fn(),
    delete: vi.fn().mockResolvedValue(undefined),
    delete_version: vi.fn().mockResolvedValue(undefined),
    exists: vi.fn().mockResolvedValue(false),
    list: vi.fn().mockResolvedValue([]),
    list_versions: vi.fn().mockResolvedValue([]),
    probe_immutability: vi.fn(),
    begin_multipart_upload: vi.fn().mockResolvedValue(handle),
    copy: vi.fn().mockResolvedValue(undefined),
    abort_incomplete_uploads: vi.fn().mockResolvedValue(0),
  };
}

function make_cipher() {
  const chunks: Buffer[] = [];
  return {
    cipher: {
      update: (chunk: Buffer) => {
        chunks.push(chunk);
        return Buffer.from(chunk);
      },
      final: () => Buffer.alloc(0),
      getAuthTag: () => Buffer.alloc(16, 0xff),
    },
    iv: Buffer.alloc(12, 0xaa),
  };
}

function make_ctx(storage: ObjectStorage): TenantContext {
  return {
    tenant_id: 'tenant-1',
    storage,
    encrypt: vi.fn((data: Buffer) => data),
    decrypt: vi.fn((data: Buffer) => data),
    create_cipher: vi.fn().mockReturnValue(make_cipher()),
  };
}

describe('process_large_file', () => {
  let handle: ReturnType<typeof make_handle>;
  let storage: ObjectStorage;
  let ctx: TenantContext;
  let connector: OneDriveConnector;

  beforeEach(() => {
    handle = make_handle();
    storage = make_storage(handle);
    ctx = make_ctx(storage);
    connector = {
      list_drives: vi.fn(),
      fetch_delta: vi.fn(),
      download_file_content: vi.fn(),
      resolve_download_url: vi.fn().mockResolvedValue('https://dl.example/resolved'),
    };
  });

  it('uploads to staging, copies to canonical, deletes staging on non-duplicate', async () => {
    const result = await process_large_file(connector, make_item(), 'owner-1', ctx);

    expect(result.stored).toBe(true);
    expect(result.deduplicated).toBe(false);
    expect(result.checksum).toBeDefined();
    expect(result.storage_key).toMatch(/^onedrive\/data\/owner-1\//);

    expect(storage.begin_multipart_upload).toHaveBeenCalledOnce();
    const staging_key = vi.mocked(storage.begin_multipart_upload).mock.calls[0][0];
    expect(staging_key).toMatch(/^onedrive\/staging\/owner-1\/file-1-/);

    expect(handle.complete).toHaveBeenCalledOnce();
    expect(storage.copy).toHaveBeenCalledOnce();
    expect(storage.delete).toHaveBeenCalledWith(staging_key);
    expect(handle.abort).not.toHaveBeenCalled();
  });

  it('aborts multipart upload when canonical key already exists (dedup)', async () => {
    vi.mocked(storage.exists).mockResolvedValue(true);

    const result = await process_large_file(connector, make_item(), 'owner-1', ctx);

    expect(result.stored).toBe(false);
    expect(result.deduplicated).toBe(true);
    expect(handle.abort).toHaveBeenCalledOnce();
    expect(handle.complete).not.toHaveBeenCalled();
    expect(storage.copy).not.toHaveBeenCalled();
  });

  it('aborts multipart upload on stream error', async () => {
    vi.mocked(ctx.create_cipher).mockReturnValue({
      cipher: {
        update: () => {
          throw new Error('cipher boom');
        },
        final: () => Buffer.alloc(0),
        getAuthTag: () => Buffer.alloc(16),
      },
      iv: Buffer.alloc(12),
    });

    await expect(process_large_file(connector, make_item(), 'owner-1', ctx)).rejects.toThrow(
      'cipher boom',
    );

    expect(handle.abort).toHaveBeenCalledOnce();
  });

  it('uploads deferred part 1 with IV + auth_tag header last', async () => {
    await process_large_file(connector, make_item(), 'owner-1', ctx);

    const upload_calls = vi.mocked(handle.upload_part).mock.calls;
    const part1_call = upload_calls.find(([pn]) => pn === 1);
    expect(part1_call).toBeDefined();

    const part1_data = part1_call![1] as Buffer;
    expect(part1_data.subarray(0, 12)).toEqual(Buffer.alloc(12, 0xaa));
    expect(part1_data.subarray(12, 28)).toEqual(Buffer.alloc(16, 0xff));
    expect(part1_data.length).toBeGreaterThan(28);
  });

  it('resolves download URL when not present on item', async () => {
    const item = make_item({ download_url: undefined });
    await process_large_file(connector, item, 'owner-1', ctx);

    expect(connector.resolve_download_url).toHaveBeenCalledWith(item);
  });

  it('passes object_lock_policy to copy()', async () => {
    const policy = { mode: 'GOVERNANCE' as const, retain_until: '2026-12-31T00:00:00Z' };
    await process_large_file(connector, make_item(), 'owner-1', ctx, policy);

    const copy_calls = vi.mocked(storage.copy).mock.calls;
    expect(copy_calls[0][3]).toEqual(policy);
  });
});

describe('cleanup_stale_staging', () => {
  it('deletes completed staging objects and aborts incomplete uploads', async () => {
    const storage: ObjectStorage = {
      put: vi.fn().mockResolvedValue(undefined),
      get: vi.fn(),
      delete: vi.fn().mockResolvedValue(undefined),
      delete_version: vi.fn().mockResolvedValue(undefined),
      exists: vi.fn(),
      list: vi.fn().mockResolvedValue(['onedrive/staging/o/stale-1', 'onedrive/staging/o/stale-2']),
      list_versions: vi.fn(),
      probe_immutability: vi.fn(),
      begin_multipart_upload: vi.fn(),
      copy: vi.fn().mockResolvedValue(undefined),
      abort_incomplete_uploads: vi.fn().mockResolvedValue(1),
    };
    const ctx = make_ctx(storage);

    await cleanup_stale_staging(ctx, 'o');

    expect(storage.list).toHaveBeenCalledWith('onedrive/staging/o/');
    expect(storage.delete).toHaveBeenCalledTimes(2);
    expect(storage.abort_incomplete_uploads).toHaveBeenCalledWith('onedrive/staging/o/');
  });
});
