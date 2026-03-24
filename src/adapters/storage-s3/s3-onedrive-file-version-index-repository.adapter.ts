import { injectable } from 'inversify';
import type {
  OneDriveFileVersionIndex,
  OneDriveFileVersionRecord,
} from '@/domain/onedrive-manifest';
import type { OneDriveFileVersionIndexRepository } from '@/ports/onedrive/file-version-index-repository.port';
import type { TenantContext } from '@/ports/tenant/context.port';
import {
  onedrive_index_key,
  onedrive_index_prefix,
} from '@/services/onedrive/onedrive-storage-keys';

@injectable()
export class S3OneDriveFileVersionIndexRepository implements OneDriveFileVersionIndexRepository {
  async find_by_file_id(
    ctx: TenantContext,
    owner_id: string,
    file_id: string,
  ): Promise<OneDriveFileVersionIndex | undefined> {
    const key = onedrive_index_key(owner_id, file_id);
    const exists = await ctx.storage.exists(key);
    if (!exists) return undefined;
    return this.download_index(ctx, key);
  }

  async append_version(
    ctx: TenantContext,
    owner_id: string,
    file_id: string,
    version: OneDriveFileVersionRecord,
  ): Promise<OneDriveFileVersionIndex> {
    const current = await this.find_by_file_id(ctx, owner_id, file_id);
    const next: OneDriveFileVersionIndex = {
      file_id,
      owner_id,
      versions: [...(current?.versions ?? []), version],
    };
    await this.save_index(ctx, next);
    return next;
  }

  async list_by_owner(ctx: TenantContext, owner_id: string): Promise<OneDriveFileVersionIndex[]> {
    const keys = await ctx.storage.list(onedrive_index_prefix(owner_id));
    const results: OneDriveFileVersionIndex[] = [];
    for (const key of keys) {
      const idx = await this.download_index(ctx, key);
      if (idx) results.push(idx);
    }
    return results;
  }

  private async save_index(ctx: TenantContext, index: OneDriveFileVersionIndex): Promise<void> {
    const key = onedrive_index_key(index.owner_id, index.file_id);
    const payload = Buffer.from(JSON.stringify(index));
    await ctx.storage.put(key, ctx.encrypt(payload));
  }

  private async download_index(
    ctx: TenantContext,
    key: string,
  ): Promise<OneDriveFileVersionIndex | undefined> {
    try {
      const payload = await ctx.storage.get(key);
      const json = ctx.decrypt(payload).toString('utf-8');
      return JSON.parse(json) as OneDriveFileVersionIndex;
    } catch {
      return undefined;
    }
  }
}
