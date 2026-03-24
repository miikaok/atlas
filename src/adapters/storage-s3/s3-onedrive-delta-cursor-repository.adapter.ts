import { injectable } from 'inversify';
import type { OneDriveDeltaCursor } from '@/domain/onedrive-manifest';
import type { OneDriveDeltaCursorRepository } from '@/ports/onedrive/delta-cursor-repository.port';
import type { TenantContext } from '@/ports/tenant/context.port';
import { onedrive_delta_cursor_key } from '@/services/onedrive/onedrive-storage-keys';

@injectable()
export class S3OneDriveDeltaCursorRepository implements OneDriveDeltaCursorRepository {
  async load(ctx: TenantContext, owner_id: string): Promise<OneDriveDeltaCursor | undefined> {
    const key = onedrive_delta_cursor_key(owner_id);
    const exists = await ctx.storage.exists(key);
    if (!exists) return undefined;

    try {
      const payload = await ctx.storage.get(key);
      const json = ctx.decrypt(payload).toString('utf-8');
      return JSON.parse(json) as OneDriveDeltaCursor;
    } catch {
      return undefined;
    }
  }

  async save(ctx: TenantContext, cursor: OneDriveDeltaCursor): Promise<void> {
    const key = onedrive_delta_cursor_key(cursor.owner_id);
    const payload = Buffer.from(JSON.stringify(cursor));
    await ctx.storage.put(key, ctx.encrypt(payload));
  }
}
