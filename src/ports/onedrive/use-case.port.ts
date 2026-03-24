import type {
  OneDriveFileVersionRecord,
  OneDriveSnapshotManifest,
} from '@/domain/onedrive-manifest';

export interface OneDriveBackupSummary {
  readonly drives_scanned: number;
  readonly files_changed: number;
  readonly files_stored: number;
  readonly files_deduplicated: number;
  readonly deleted_items: number;
  readonly cursor_updated: boolean;
  readonly snapshot_created: boolean;
}

export interface OneDriveBackupResult {
  readonly owner_id: string;
  readonly snapshot: OneDriveSnapshotManifest | undefined;
  readonly summary: OneDriveBackupSummary;
}

export interface OneDriveBackupOptions {
  readonly force_full?: boolean | undefined;
}

export interface OneDriveFileVersionSummary {
  readonly file_id: string;
  readonly file_name: string;
  readonly parent_path: string;
  readonly backup_at: string;
  readonly snapshot_id: string;
  readonly change_type: string;
}

export interface OneDriveCatalogUseCase {
  list_onedrive_snapshots(tenant_id: string, owner_id: string): Promise<OneDriveSnapshotManifest[]>;
  list_onedrive_file_versions(
    tenant_id: string,
    owner_id: string,
    file_ref: string,
  ): Promise<OneDriveFileVersionRecord[]>;
}

export interface OneDriveBackupUseCase {
  backup_onedrive(
    tenant_id: string,
    owner_id: string,
    options?: OneDriveBackupOptions,
  ): Promise<OneDriveBackupResult>;
}

export interface OneDriveVerificationResult {
  readonly snapshot_id: string;
  readonly total_checked: number;
  readonly passed: number;
  readonly failed_file_ids: string[];
  readonly index_issues: string[];
}

export interface OneDriveVerificationUseCase {
  verify_onedrive_snapshot(
    tenant_id: string,
    snapshot_id: string,
  ): Promise<OneDriveVerificationResult>;
}
