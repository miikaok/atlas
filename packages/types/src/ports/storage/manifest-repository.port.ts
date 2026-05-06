import type { Manifest } from '@/domain/manifest';
import type { TenantContext } from '@/ports/tenant/context.port';

export interface ManifestRepository {
  save(ctx: TenantContext, manifest: Manifest): Promise<void>;

  find_by_snapshot(ctx: TenantContext, snapshot_id: string): Promise<Manifest | undefined>;

  find_latest_by_mailbox(ctx: TenantContext, mailbox_id: string): Promise<Manifest | undefined>;

  /** Downloads and decrypts every manifest in the tenant bucket. */
  list_all_manifests(ctx: TenantContext): Promise<Manifest[]>;
}
