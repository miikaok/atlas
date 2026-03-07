import { inject, injectable } from 'inversify';
import type { TenantContextFactory } from '@/ports/tenant-context.port';
import { TENANT_CONTEXT_FACTORY_TOKEN } from '@/ports/tenant-context.port';
import type { TenantContext } from '@/ports/tenant-context.port';
import type { ManifestRepository } from '@/ports/manifest-repository.port';
import { MANIFEST_REPOSITORY_TOKEN } from '@/ports/manifest-repository.port';
import type { Manifest, ManifestEntry } from '@/domain/manifest';

export interface RestoreResult {
  readonly snapshot_id: string;
  readonly restored_count: number;
  readonly errors: string[];
}

@injectable()
export class RestoreService {
  constructor(
    @inject(TENANT_CONTEXT_FACTORY_TOKEN) private readonly _tenant_factory: TenantContextFactory,
    @inject(MANIFEST_REPOSITORY_TOKEN) private readonly _manifests: ManifestRepository,
  ) {}

  /**
   * Restores all messages from a backup snapshot by fetching
   * each encrypted object, decrypting it, and (eventually) pushing to a mailbox.
   */
  async restore_snapshot(
    tenant_id: string,
    snapshot_id: string,
    _target_mailbox_id?: string,
  ): Promise<RestoreResult> {
    const ctx = await this._tenant_factory.create(tenant_id);
    const manifest = await this.load_manifest_for_snapshot(ctx, snapshot_id);
    const { restored_count, errors } = await this.restore_all_entries(ctx, manifest.entries);
    return { snapshot_id, restored_count, errors };
  }

  /** Loads the manifest for a snapshot, throwing if none exists. */
  private async load_manifest_for_snapshot(
    ctx: TenantContext,
    snapshot_id: string,
  ): Promise<Manifest> {
    const manifest = await this._manifests.find_by_snapshot(ctx, snapshot_id);
    if (!manifest) {
      throw new Error(`No manifest found for snapshot ${snapshot_id}`);
    }
    return manifest;
  }

  /** Attempts to restore every entry, collecting errors without aborting. */
  private async restore_all_entries(
    ctx: TenantContext,
    entries: ManifestEntry[],
  ): Promise<{ restored_count: number; errors: string[] }> {
    const errors: string[] = [];
    let restored_count = 0;

    for (const entry of entries) {
      const error = await this.restore_single_entry(ctx, entry);
      if (error) {
        errors.push(error);
      } else {
        restored_count++;
      }
    }

    return { restored_count, errors };
  }

  /**
   * Fetches and decrypts a single entry from storage.
   * Returns an error string on failure, or null on success.
   */
  private async restore_single_entry(
    ctx: TenantContext,
    entry: ManifestEntry,
  ): Promise<string | null> {
    try {
      const ciphertext = await ctx.storage.get(entry.storage_key);
      ctx.decrypt(ciphertext);
      // TODO: push decrypted message back to mailbox via connector
      return null;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return `${entry.object_id}: ${message}`;
    }
  }
}
