export type {
  ObjectStorage,
  StorageObjectLockMode,
  StorageObjectLockPolicy,
  StorageImmutabilityProbeRequest,
  StorageImmutabilityProbeResult,
  StorageObjectVersion,
} from './storage/object-storage.port';

export type {
  MailboxConnector,
  MailMessage,
  MailFolder,
  DeltaSyncResult,
  DeltaPageCallback,
  MessageAttachment,
} from './mail/connector.port';

export type {
  TenantMailbox,
  MailboxDiscoveryOptions,
  MailboxDiscoveryService,
} from './mail/discovery.port';

export type { ManifestRepository } from './storage/manifest-repository.port';

export type { KeyService } from './crypto/key-service.port';

export type {
  TenantContext,
  TenantContextFactory,
  TenantStorageContext,
  TenantCryptoContext,
} from './tenant/context.port';

export type { RestoreConnector, AttachmentUpload, UploadSession } from './restore/connector.port';

export type {
  BackupUseCase,
  SyncOptions,
  SyncResult,
  BackupSyncSummary,
  BackupSyncMode,
  BackupProgressReporter,
  ObjectLockPolicy,
} from './backup/use-case.port';

export type {
  TenantBackupOptions,
  MailboxBackupOutcome,
  TenantBackupResult,
  TenantBackupOrchestrator,
} from './backup/orchestrator.port';

export type { TenantProgressReporter } from './backup/tenant-progress.port';

export type { VerificationUseCase, VerificationResult } from './verification/use-case.port';

export type { RestoreUseCase, RestoreResult, RestoreOptions } from './restore/use-case.port';

export type { CatalogUseCase, MailboxSummary, ReadMessageResult } from './catalog/use-case.port';

export type { DeletionUseCase, DeletionResult } from './deletion/use-case.port';

export type {
  StorageCheckUseCase,
  StorageCheckRequest,
  StorageCheckResult,
} from './storage-check/use-case.port';

export type { StatsUseCase } from './stats/use-case.port';

export type { SaveOptions, SaveResult, SaveUseCase } from './save/use-case.port';

export type { FolderStatus, MailboxStatusResult, StatusUseCase } from './status/use-case.port';

export type { ReplicationUseCase } from './replication/use-case.port';
export type {
  StorageTarget,
  StorageTargetConfig,
  StorageTargetFactory,
} from './replication/storage-target.port';
export type { DekValidationFn } from './replication/dek-validation.port';

export type { AtlasInstanceConfig, AtlasInstance } from './atlas/use-case.port';

export {
  OBJECT_STORAGE_TOKEN,
  MAILBOX_CONNECTOR_TOKEN,
  MAILBOX_DISCOVERY_TOKEN,
  MANIFEST_REPOSITORY_TOKEN,
  KEY_SERVICE_TOKEN,
  TENANT_CONTEXT_FACTORY_TOKEN,
  RESTORE_CONNECTOR_TOKEN,
  DEK_VALIDATION_FN_TOKEN,
  STORAGE_TARGET_FACTORY_TOKEN,
} from './tokens/outgoing.tokens';

export {
  BACKUP_USE_CASE_TOKEN,
  VERIFICATION_USE_CASE_TOKEN,
  RESTORE_USE_CASE_TOKEN,
  CATALOG_USE_CASE_TOKEN,
  DELETION_USE_CASE_TOKEN,
  STORAGE_CHECK_USE_CASE_TOKEN,
  SAVE_USE_CASE_TOKEN,
  STATS_USE_CASE_TOKEN,
  STATUS_USE_CASE_TOKEN,
  TENANT_ORCHESTRATOR_TOKEN,
  REPLICATION_USE_CASE_TOKEN,
} from './tokens/use-case.tokens';
