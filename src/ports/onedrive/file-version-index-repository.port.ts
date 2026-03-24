import type {
  OneDriveFileVersionIndex,
  OneDriveFileVersionRecord,
} from '@/domain/onedrive-manifest';
import type { TenantContext } from '@/ports/tenant/context.port';

export interface OneDriveFileVersionIndexRepository {
  find_by_file_id(
    ctx: TenantContext,
    owner_id: string,
    file_id: string,
  ): Promise<OneDriveFileVersionIndex | undefined>;
  append_version(
    ctx: TenantContext,
    owner_id: string,
    file_id: string,
    version: OneDriveFileVersionRecord,
  ): Promise<OneDriveFileVersionIndex>;
  list_by_owner(ctx: TenantContext, owner_id: string): Promise<OneDriveFileVersionIndex[]>;
}
