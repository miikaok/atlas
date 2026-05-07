export {
  EnvelopeKeyService,
  derive_kek,
  CURRENT_KEK_PARAMS,
  KEK_PARAMS_HISTORY,
} from './envelope-key-service.adapter';
export type { KekParams } from './envelope-key-service.adapter';
export { load_dek_with_migration, load_kek_params, save_kek_params } from './kek-params-store';
