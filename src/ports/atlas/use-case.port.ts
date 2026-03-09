import type { SyncOptions, SyncResult } from '@/ports/backup/use-case.port';
import type { VerificationResult } from '@/ports/verification/use-case.port';
import type { RestoreOptions, RestoreResult } from '@/ports/restore/use-case.port';
import type { MailboxSummary, ReadMessageResult } from '@/ports/catalog/use-case.port';
import type { Manifest } from '@/domain/manifest';
import type { DeletionResult } from '@/ports/deletion/use-case.port';
import type { StorageCheckRequest, StorageCheckResult } from '@/ports/storage-check/use-case.port';

export interface AtlasInstanceConfig {
  readonly tenantId: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly s3Endpoint: string;
  readonly s3AccessKey: string;
  readonly s3SecretKey: string;
  readonly s3Region?: string;
  readonly encryptionPassphrase: string;
}

export interface AtlasInstance {
  backupMailbox(mailboxId: string, options?: SyncOptions): Promise<SyncResult>;
  verifySnapshot(snapshotId: string): Promise<VerificationResult>;
  restoreSnapshot(snapshotId: string, options?: RestoreOptions): Promise<RestoreResult>;
  restoreMailbox(mailboxId: string, options?: RestoreOptions): Promise<RestoreResult>;
  listMailboxes(): Promise<MailboxSummary[]>;
  listSnapshots(mailboxId: string): Promise<Manifest[]>;
  getSnapshotDetail(snapshotId: string): Promise<Manifest | undefined>;
  readMessage(snapshotId: string, messageRef: string): Promise<ReadMessageResult | undefined>;
  deleteMailboxData(mailboxId: string): Promise<DeletionResult>;
  deleteSnapshot(snapshotId: string): Promise<DeletionResult>;
  checkStorage(request?: StorageCheckRequest): Promise<StorageCheckResult>;
}
