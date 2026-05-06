export type { AtlasInstance, AtlasInstanceConfig } from '@atlas/types';
export type { BucketStats, MailboxStats, FolderStats, MonthlyBreakdown } from '@atlas/types';
export type { MailboxStatusResult, FolderStatus } from '@atlas/types';
export type { ReplicationResult, ReplicationStatusRecord } from '@atlas/types';
export type { StorageTarget, StorageTargetConfig } from '@atlas/types';
export type { StorageTargetSdkConfig } from '@atlas/s3';
export { createAtlasInstance } from '@/atlas-instance.adapter';
export { create_storage_target as createStorageTarget } from '@atlas/s3';
