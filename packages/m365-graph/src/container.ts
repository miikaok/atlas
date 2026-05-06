import { type Container } from 'inversify';
import type { GraphConfig } from '@atlas/core/utils/config';
import { create_graph_client, GRAPH_CLIENT_TOKEN } from '@/graph-client.factory';

export function bind_graph_client(container: Container, config: GraphConfig): void {
  const graph_client = create_graph_client(config);
  container.bind(GRAPH_CLIENT_TOKEN).toConstantValue(graph_client);
}
