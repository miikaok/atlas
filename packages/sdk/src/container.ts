import 'reflect-metadata';
import { Container } from 'inversify';
import { type AtlasConfig, load_config, ATLAS_CONFIG_TOKEN } from '@atlas/core';
import { bind_core_services } from '@atlas/core';
import { bind_graph_client } from '@atlas/m365-graph';
import { bind_s3_storage } from '@atlas/s3';
import { bind_outlook } from '@atlas/outlook';

export function create_container(): Container {
  const config = load_config();
  return create_container_from_config(config);
}

export function create_container_from_config(config: AtlasConfig): Container {
  const container = new Container();
  container.bind<AtlasConfig>(ATLAS_CONFIG_TOKEN).toConstantValue(config);
  bind_graph_client(container, config);
  bind_s3_storage(container, config);
  bind_core_services(container);
  bind_outlook(container);
  return container;
}
