import { describe, it, expect, vi } from 'vitest';
import { ensure_source_dek_on_primary } from '@/services/replication/rehydration-dek-helper';
import type { StorageTarget } from '@/ports/replication/storage-target.port';
import type { TenantContext } from '@/ports/tenant/context.port';

const DEK = '_meta/dek.enc';
const blob = Buffer.from('wrapped-dek-blob');

interface MockBucketStorage {
  exists: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  put: ReturnType<typeof vi.fn>;
  list: ReturnType<typeof vi.fn>;
}

function make_storage(
  overrides: {
    exists_map?: Record<string, boolean>;
    list_result?: string[];
  } = {},
): MockBucketStorage {
  const exists_map = overrides.exists_map ?? {};
  return {
    exists: vi.fn((key: string) => Promise.resolve(exists_map[key] ?? false)),
    get: vi.fn().mockResolvedValue(blob),
    put: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockImplementation((prefix: string) => {
      if (prefix === 'manifests/') {
        return Promise.resolve(overrides.list_result ?? []);
      }
      return Promise.resolve([]);
    }),
  };
}

function make_target(storage: MockBucketStorage): StorageTarget {
  return {
    target_id: 't1',
    endpoint: 'http://x',
    create_context: vi.fn(async () => ({ tenant_id: 'tid', storage }) as unknown as TenantContext),
  } as unknown as StorageTarget;
}

describe('ensure_source_dek_on_primary', () => {
  it('does nothing when source has no DEK', async () => {
    const source = make_storage({ exists_map: { [DEK]: false } });
    const primary = make_storage({ exists_map: { [DEK]: false } });
    await ensure_source_dek_on_primary(make_target(primary), make_target(source), 'tid');
    expect(primary.put).not.toHaveBeenCalled();
  });

  it('copies DEK when primary has none', async () => {
    const source = make_storage({ exists_map: { [DEK]: true } });
    const primary = make_storage({ exists_map: { [DEK]: false } });
    await ensure_source_dek_on_primary(make_target(primary), make_target(source), 'tid');
    expect(primary.put).toHaveBeenCalledWith(DEK, blob);
    expect(source.get).toHaveBeenCalledWith(DEK);
  });

  it('does not overwrite when primary has DEK and manifests', async () => {
    const source = make_storage({ exists_map: { [DEK]: true }, list_result: ['manifests/a.json'] });
    const primary = make_storage({
      exists_map: { [DEK]: true },
      list_result: ['manifests/b.json'],
    });
    await ensure_source_dek_on_primary(make_target(primary), make_target(source), 'tid');
    expect(primary.put).not.toHaveBeenCalled();
  });

  it('overwrites when primary has DEK but no manifests', async () => {
    const source = make_storage({ exists_map: { [DEK]: true } });
    const primary = make_storage({ exists_map: { [DEK]: true }, list_result: [] });
    await ensure_source_dek_on_primary(make_target(primary), make_target(source), 'tid');
    expect(primary.put).toHaveBeenCalledWith(DEK, blob);
  });
});
