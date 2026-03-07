import 'reflect-metadata';
import { Container } from 'inversify';
import { MAILBOX_CONNECTOR_TOKEN } from '@/ports/mailbox-connector.port';
import { MANIFEST_REPOSITORY_TOKEN } from '@/ports/manifest-repository.port';
import { TENANT_CONTEXT_FACTORY_TOKEN } from '@/ports/tenant-context.port';
import { GraphMailboxConnector } from '@/adapters/m365/graph-mailbox-connector.adapter';
import { create_graph_client, GRAPH_CLIENT_TOKEN } from '@/adapters/m365/graph-client.factory';
import { create_s3_client, S3_CLIENT_TOKEN } from '@/adapters/storage-s3/s3-client.factory';
import { S3ManifestRepository } from '@/adapters/storage-s3/s3-manifest-repository.adapter';
import { DefaultTenantContextFactory } from '@/adapters/tenant-context.factory';
import { MailboxSyncService } from '@/services/mailbox-sync.service';
import { VerificationService } from '@/services/verification.service';
import { RestoreService } from '@/services/restore.service';
import { CatalogService } from '@/services/catalog.service';
import { DeletionService } from '@/services/deletion.service';
import type { AtlasConfig } from '@/utils/config';
import { load_config, ATLAS_CONFIG_TOKEN } from '@/utils/config';

/** Creates and configures the application-wide DI container. */
export function create_container(): Container {
  const container = new Container();
  bind_config(container);
  bind_infrastructure(container);
  bind_adapters(container);
  bind_services(container);
  return container;
}

/** Loads and binds the Atlas configuration (config file + env vars). */
function bind_config(container: Container): void {
  const config = load_config();
  container.bind<AtlasConfig>(ATLAS_CONFIG_TOKEN).toConstantValue(config);
}

/** Creates and binds infrastructure clients (Graph API, S3). */
function bind_infrastructure(container: Container): void {
  const config = container.get<AtlasConfig>(ATLAS_CONFIG_TOKEN);

  const graph_client = create_graph_client(config);
  container.bind(GRAPH_CLIENT_TOKEN).toConstantValue(graph_client);

  const s3_client = create_s3_client(config);
  container.bind(S3_CLIENT_TOKEN).toConstantValue(s3_client);
}

/** Binds adapters to their port tokens. */
function bind_adapters(container: Container): void {
  container.bind(MAILBOX_CONNECTOR_TOKEN).to(GraphMailboxConnector).inSingletonScope();
  container.bind(TENANT_CONTEXT_FACTORY_TOKEN).to(DefaultTenantContextFactory).inSingletonScope();
  container.bind(MANIFEST_REPOSITORY_TOKEN).to(S3ManifestRepository).inSingletonScope();
}

/** Binds service classes so Inversify can auto-resolve their constructor dependencies. */
function bind_services(container: Container): void {
  container.bind(MailboxSyncService).toSelf();
  container.bind(VerificationService).toSelf();
  container.bind(RestoreService).toSelf();
  container.bind(CatalogService).toSelf();
  container.bind(DeletionService).toSelf();
}
