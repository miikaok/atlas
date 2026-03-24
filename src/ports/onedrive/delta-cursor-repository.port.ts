import type { OneDriveDeltaCursor } from '@/domain/onedrive-manifest';
import type { TenantContext } from '@/ports/tenant/context.port';

export interface OneDriveDeltaCursorRepository {
  load(ctx: TenantContext, owner_id: string): Promise<OneDriveDeltaCursor | undefined>;
  save(ctx: TenantContext, cursor: OneDriveDeltaCursor): Promise<void>;
}
