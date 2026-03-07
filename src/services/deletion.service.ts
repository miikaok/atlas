import { inject, injectable } from 'inversify';
import type { TenantContextFactory } from '@/ports/tenant-context.port';
import { TENANT_CONTEXT_FACTORY_TOKEN } from '@/ports/tenant-context.port';
import type { ManifestRepository } from '@/ports/manifest-repository.port';
import { MANIFEST_REPOSITORY_TOKEN } from '@/ports/manifest-repository.port';

export interface DeletionResult {
  readonly deleted_objects: number;
  readonly deleted_manifests: number;
}

@injectable()
export class DeletionService {
  constructor(
    @inject(TENANT_CONTEXT_FACTORY_TOKEN) private readonly _tenant_factory: TenantContextFactory,
    @inject(MANIFEST_REPOSITORY_TOKEN) private readonly _manifests: ManifestRepository,
  ) {}

  /**
   * Deletes all data objects and manifests for a single mailbox.
   * Keys: data/{mailbox_id}/*, manifests/{mailbox_id}/*
   */
  async delete_mailbox_data(tenant_id: string, mailbox_id: string): Promise<DeletionResult> {
    mailbox_id = mailbox_id.toLowerCase();
    const ctx = await this._tenant_factory.create(tenant_id);

    const data_keys = await ctx.storage.list(`data/${mailbox_id}/`);
    const manifest_keys = await ctx.storage.list(`manifests/${mailbox_id}/`);

    await delete_keys(ctx.storage, [...data_keys, ...manifest_keys]);

    return {
      deleted_objects: data_keys.length,
      deleted_manifests: manifest_keys.length,
    };
  }

  /**
   * Deletes a single snapshot manifest. The data objects are retained
   * because they may be referenced by other snapshots (content-addressed).
   */
  async delete_snapshot(tenant_id: string, snapshot_id: string): Promise<DeletionResult> {
    const ctx = await this._tenant_factory.create(tenant_id);
    const manifest = await this._manifests.find_by_snapshot(ctx, snapshot_id);

    if (!manifest) {
      return { deleted_objects: 0, deleted_manifests: 0 };
    }

    const key = `manifests/${manifest.mailbox_id}/${manifest.snapshot_id}.json`;
    await ctx.storage.delete(key);

    return { deleted_objects: 0, deleted_manifests: 1 };
  }

  /**
   * Removes everything in the tenant bucket: data, manifests, and _meta
   * (including the encrypted DEK). This is irreversible.
   */
  async purge_tenant(tenant_id: string): Promise<DeletionResult> {
    const ctx = await this._tenant_factory.create(tenant_id);

    const data_keys = await ctx.storage.list('data/');
    const manifest_keys = await ctx.storage.list('manifests/');
    const meta_keys = await ctx.storage.list('_meta/');

    const all_keys = [...data_keys, ...manifest_keys, ...meta_keys];
    await delete_keys(ctx.storage, all_keys);

    return {
      deleted_objects: data_keys.length + meta_keys.length,
      deleted_manifests: manifest_keys.length,
    };
  }
}

/** Deletes an array of keys sequentially from storage. */
async function delete_keys(
  storage: { delete(key: string): Promise<void> },
  keys: string[],
): Promise<void> {
  for (const key of keys) {
    await storage.delete(key);
  }
}
