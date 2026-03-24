import { inject, injectable } from 'inversify';
import type { OneDriveCatalogUseCase } from '@/ports/onedrive/use-case.port';
import type { OneDriveManifestRepository } from '@/ports/onedrive/manifest-repository.port';
import type { OneDriveFileVersionIndexRepository } from '@/ports/onedrive/file-version-index-repository.port';
import type { TenantContextFactory } from '@/ports/tenant/context.port';
import type {
  OneDriveFileVersionRecord,
  OneDriveSnapshotManifest,
} from '@/domain/onedrive-manifest';
import {
  ONEDRIVE_MANIFEST_REPOSITORY_TOKEN,
  ONEDRIVE_FILE_INDEX_REPOSITORY_TOKEN,
  TENANT_CONTEXT_FACTORY_TOKEN,
} from '@/ports/tokens/outgoing.tokens';

@injectable()
export class OneDriveCatalogService implements OneDriveCatalogUseCase {
  constructor(
    @inject(TENANT_CONTEXT_FACTORY_TOKEN) private readonly _tenant_factory: TenantContextFactory,
    @inject(ONEDRIVE_MANIFEST_REPOSITORY_TOKEN)
    private readonly _manifests: OneDriveManifestRepository,
    @inject(ONEDRIVE_FILE_INDEX_REPOSITORY_TOKEN)
    private readonly _file_indexes: OneDriveFileVersionIndexRepository,
  ) {}

  async list_onedrive_snapshots(
    tenant_id: string,
    owner_id: string,
  ): Promise<OneDriveSnapshotManifest[]> {
    const ctx = await this._tenant_factory.create(tenant_id);
    return this._manifests.list_snapshots_by_owner(ctx, owner_id);
  }

  async list_onedrive_file_versions(
    tenant_id: string,
    owner_id: string,
    file_ref: string,
  ): Promise<OneDriveFileVersionRecord[]> {
    const ctx = await this._tenant_factory.create(tenant_id);
    if (!is_path_ref(file_ref)) {
      const direct = await this._file_indexes.find_by_file_id(ctx, owner_id, file_ref);
      if (direct) return sort_versions_desc(direct.versions);
    }

    const indexes = await this._file_indexes.list_by_owner(ctx, owner_id);
    const resolved = indexes.find((index) => matches_file_ref(index.versions, file_ref));
    return sort_versions_desc(resolved?.versions ?? []);
  }
}

function is_path_ref(file_ref: string): boolean {
  return file_ref.includes('/');
}

function matches_file_ref(versions: OneDriveFileVersionRecord[], file_ref: string): boolean {
  const normalized_ref = normalize_path(file_ref);
  return versions.some((version) => {
    if (version.file_name === file_ref) return true;
    const full_path = normalize_path(`${version.parent_path}/${version.file_name}`);
    return full_path === normalized_ref;
  });
}

function normalize_path(path: string): string {
  return path.replace(/\/+/g, '/').replace(/\/$/, '').toLowerCase();
}

function sort_versions_desc(versions: OneDriveFileVersionRecord[]): OneDriveFileVersionRecord[] {
  return [...versions].sort(
    (a, b) => new Date(b.backup_at).getTime() - new Date(a.backup_at).getTime(),
  );
}
