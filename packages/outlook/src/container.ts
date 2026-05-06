import { type Container } from 'inversify';
import {
  MAILBOX_CONNECTOR_TOKEN,
  RESTORE_CONNECTOR_TOKEN,
  MAILBOX_DISCOVERY_TOKEN,
  BACKUP_USE_CASE_TOKEN,
  RESTORE_USE_CASE_TOKEN,
  SAVE_USE_CASE_TOKEN,
  STATUS_USE_CASE_TOKEN,
  TENANT_ORCHESTRATOR_TOKEN,
} from '@atlas/types';
import { GraphMailboxConnector } from '@/adapters/graph-mailbox-connector.adapter';
import { GraphRestoreConnector } from '@/adapters/graph-restore-connector.adapter';
import { GraphMailboxDiscoveryAdapter } from '@/adapters/graph-mailbox-discovery.adapter';
import { MailboxSyncService } from '@/services/backup/mailbox-sync.service';
import { RestoreService } from '@/services/restore/restore.service';
import { SaveService } from '@/services/save/save.service';
import { MailboxStatusService } from '@/services/status/mailbox-status.service';
import { DefaultTenantBackupOrchestrator } from '@/services/backup/tenant-backup-orchestrator';

/** Registers Outlook Graph adapters and backup/restore/save/status use cases on the container. */
export function bind_outlook(container: Container): void {
  container.bind(MAILBOX_CONNECTOR_TOKEN).to(GraphMailboxConnector).inSingletonScope();
  container.bind(RESTORE_CONNECTOR_TOKEN).to(GraphRestoreConnector).inSingletonScope();
  container.bind(MAILBOX_DISCOVERY_TOKEN).to(GraphMailboxDiscoveryAdapter).inSingletonScope();

  container.bind(MailboxSyncService).toSelf();
  container.bind(BACKUP_USE_CASE_TOKEN).toService(MailboxSyncService);
  container.bind(RestoreService).toSelf();
  container.bind(RESTORE_USE_CASE_TOKEN).toService(RestoreService);
  container.bind(SaveService).toSelf();
  container.bind(SAVE_USE_CASE_TOKEN).toService(SaveService);
  container.bind(MailboxStatusService).toSelf();
  container.bind(STATUS_USE_CASE_TOKEN).toService(MailboxStatusService);
  container.bind(DefaultTenantBackupOrchestrator).toSelf();
  container.bind(TENANT_ORCHESTRATOR_TOKEN).toService(DefaultTenantBackupOrchestrator);
}
