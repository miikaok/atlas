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

export type { TenantContext, TenantContextFactory } from './tenant-context.port';
export { TENANT_CONTEXT_FACTORY_TOKEN } from './tenant-context.port';
