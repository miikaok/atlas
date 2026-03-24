import type { OneDriveSnapshotManifest } from '@/domain/onedrive-manifest';
import type { TenantContext } from '@/ports/tenant/context.port';

export interface OneDriveManifestRepository {
  save(ctx: TenantContext, manifest: OneDriveSnapshotManifest): Promise<void>;
  find_by_snapshot(
    ctx: TenantContext,
    snapshot_id: string,
  ): Promise<OneDriveSnapshotManifest | undefined>;
  find_latest_by_owner(
    ctx: TenantContext,
    owner_id: string,
  ): Promise<OneDriveSnapshotManifest | undefined>;
  list_snapshots_by_owner(
    ctx: TenantContext,
    owner_id: string,
  ): Promise<OneDriveSnapshotManifest[]>;
}
