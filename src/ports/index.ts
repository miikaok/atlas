export type { ObjectStorage } from './object-storage.port';
export { OBJECT_STORAGE_TOKEN } from './object-storage.port';

export type {
  MailboxConnector,
  MailMessage,
  MailFolder,
  DeltaSyncResult,
} from './mailbox-connector.port';
export { MAILBOX_CONNECTOR_TOKEN } from './mailbox-connector.port';

export type { ManifestRepository } from './manifest-repository.port';
export { MANIFEST_REPOSITORY_TOKEN } from './manifest-repository.port';

export type { KeyService } from './key-service.port';
export { KEY_SERVICE_TOKEN } from './key-service.port';

export type {
  TenantContext,
  TenantContextFactory,
  TenantStorageContext,
  TenantCryptoContext,
} from './tenant-context.port';
export { TENANT_CONTEXT_FACTORY_TOKEN } from './tenant-context.port';

export type { RestoreConnector, AttachmentUpload, UploadSession } from './restore-connector.port';
export { RESTORE_CONNECTOR_TOKEN } from './restore-connector.port';

export type {
  BackupUseCase,
  SyncOptions,
  SyncResult,
  BackupSyncSummary,
  BackupSyncMode,
  BackupProgressReporter,
} from './backup-use-case.port';
export { BACKUP_USE_CASE_TOKEN } from './backup-use-case.port';

export type { VerificationUseCase, VerificationResult } from './verification-use-case.port';
export { VERIFICATION_USE_CASE_TOKEN } from './verification-use-case.port';

export type { RestoreUseCase, RestoreResult, RestoreOptions } from './restore-use-case.port';
export { RESTORE_USE_CASE_TOKEN } from './restore-use-case.port';

export type { CatalogUseCase, MailboxSummary, ReadMessageResult } from './catalog-use-case.port';
export { CATALOG_USE_CASE_TOKEN } from './catalog-use-case.port';

export type { DeletionUseCase, DeletionResult } from './deletion-use-case.port';
export { DELETION_USE_CASE_TOKEN } from './deletion-use-case.port';
