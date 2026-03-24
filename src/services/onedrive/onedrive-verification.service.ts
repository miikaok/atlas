import { createHash, timingSafeEqual } from 'node:crypto';
import { inject, injectable } from 'inversify';
import type {
  OneDriveVerificationResult,
  OneDriveVerificationUseCase,
} from '@/ports/onedrive/use-case.port';
import type { OneDriveManifestRepository } from '@/ports/onedrive/manifest-repository.port';
import type { OneDriveFileVersionIndexRepository } from '@/ports/onedrive/file-version-index-repository.port';
import type { TenantContext, TenantContextFactory } from '@/ports/tenant/context.port';
import {
  ONEDRIVE_MANIFEST_REPOSITORY_TOKEN,
  ONEDRIVE_FILE_INDEX_REPOSITORY_TOKEN,
  TENANT_CONTEXT_FACTORY_TOKEN,
} from '@/ports/tokens/outgoing.tokens';

@injectable()
export class OneDriveVerificationService implements OneDriveVerificationUseCase {
  constructor(
    @inject(TENANT_CONTEXT_FACTORY_TOKEN) private readonly _tenant_factory: TenantContextFactory,
    @inject(ONEDRIVE_MANIFEST_REPOSITORY_TOKEN)
    private readonly _manifests: OneDriveManifestRepository,
    @inject(ONEDRIVE_FILE_INDEX_REPOSITORY_TOKEN)
    private readonly _file_indexes: OneDriveFileVersionIndexRepository,
  ) {}

  /** Verifies OneDrive snapshot blobs and cross-checks per-file version indexes. */
  async verify_onedrive_snapshot(
    tenant_id: string,
    snapshot_id: string,
  ): Promise<OneDriveVerificationResult> {
    const ctx = await this._tenant_factory.create(tenant_id);
    const snapshot = await this._manifests.find_by_snapshot(ctx, snapshot_id);
    if (!snapshot) {
      throw new Error(`No OneDrive snapshot found for ${snapshot_id}`);
    }

    const failed_file_ids: string[] = [];
    const index_issues: string[] = [];

    for (const entry of snapshot.entries) {
      const blob_ok = await this.verify_blob_entry(ctx, entry.storage_key, entry.checksum);
      if (!blob_ok) {
        failed_file_ids.push(entry.file_id);
      }

      const index = await this._file_indexes.find_by_file_id(ctx, snapshot.owner_id, entry.file_id);
      if (!index) {
        index_issues.push(`missing index for ${entry.file_id}`);
        continue;
      }

      const version = index.versions.find((candidate) => candidate.snapshot_id === snapshot_id);
      if (!version) {
        index_issues.push(`missing version for ${entry.file_id} in snapshot ${snapshot_id}`);
      }
    }

    const total_checked = snapshot.entries.length;
    const failed_count = failed_file_ids.length + index_issues.length;
    return {
      snapshot_id,
      total_checked,
      passed: Math.max(0, total_checked - failed_count),
      failed_file_ids,
      index_issues,
    };
  }

  private async verify_blob_entry(
    ctx: TenantContext,
    storage_key: string | undefined,
    expected_checksum: string | undefined,
  ): Promise<boolean> {
    if (!storage_key || !expected_checksum) return true;
    try {
      const exists = await ctx.storage.exists(storage_key);
      if (!exists) return false;
      const encrypted = await ctx.storage.get(storage_key);
      const plaintext = ctx.decrypt(encrypted);
      const actual_checksum = createHash('sha256').update(plaintext).digest('hex');
      return this.equal_checksum(actual_checksum, expected_checksum);
    } catch {
      return false;
    }
  }

  private equal_checksum(actual: string, expected: string): boolean {
    if (actual.length !== expected.length) return false;
    return timingSafeEqual(Buffer.from(actual, 'utf-8'), Buffer.from(expected, 'utf-8'));
  }
}
