import type { ObjectStorage } from '@atlas/types';
import type { KekParams } from '@/adapters/keystore/envelope-key-service.adapter';
import {
  EnvelopeKeyService,
  CURRENT_KEK_PARAMS,
  KEK_PARAMS_HISTORY,
} from '@/adapters/keystore/envelope-key-service.adapter';
import { logger } from '@/utils/logger';

const KEK_PARAMS_KEY = '_meta/kek_params.json';
const DEK_META_KEY = '_meta/dek.enc';

/** Reads the stored KEK params, or undefined if the sidecar doesn't exist yet. */
export async function load_kek_params(storage: ObjectStorage): Promise<KekParams | undefined> {
  const exists = await storage.exists(KEK_PARAMS_KEY);
  if (!exists) return undefined;
  const raw = await storage.get(KEK_PARAMS_KEY);
  return JSON.parse(raw.toString('utf-8')) as KekParams;
}

/** Persists KEK params as a plain JSON sidecar (not encrypted — it's just algorithm metadata). */
export async function save_kek_params(storage: ObjectStorage, params: KekParams): Promise<void> {
  await storage.put(KEK_PARAMS_KEY, Buffer.from(JSON.stringify(params)));
}

/**
 * Loads and unwraps a DEK, handling KEK param versioning and migration.
 *
 * 1. If `_meta/kek_params.json` exists, derive KEK with those exact params.
 * 2. If not, walk {@link KEK_PARAMS_HISTORY} newest-first until unwrap succeeds.
 * 3. If the successful params differ from CURRENT, re-wrap the DEK and save new params.
 */
export async function load_dek_with_migration(
  storage: ObjectStorage,
  passphrase: string,
  tenant_id: string,
): Promise<{ dek: Buffer; key_service: EnvelopeKeyService }> {
  const wrapped = await storage.get(DEK_META_KEY);
  const stored_params = await load_kek_params(storage);

  if (stored_params) {
    const svc = await EnvelopeKeyService.create(passphrase, tenant_id, stored_params);
    const dek = svc.unwrap_dek(wrapped);
    if (stored_params.version < CURRENT_KEK_PARAMS.version) {
      return migrate_dek(storage, passphrase, tenant_id, dek);
    }
    return { dek, key_service: svc };
  }

  return unwrap_with_fallback(storage, passphrase, tenant_id, wrapped);
}

/** Walks the params history to find which version wrapped this DEK. */
async function unwrap_with_fallback(
  storage: ObjectStorage,
  passphrase: string,
  tenant_id: string,
  wrapped: Buffer,
): Promise<{ dek: Buffer; key_service: EnvelopeKeyService }> {
  for (const params of KEK_PARAMS_HISTORY) {
    try {
      const svc = await EnvelopeKeyService.create(passphrase, tenant_id, params);
      const dek = svc.unwrap_dek(wrapped);

      if (params.version === CURRENT_KEK_PARAMS.version) {
        await save_kek_params(storage, CURRENT_KEK_PARAMS);
        return { dek, key_service: svc };
      }

      logger.info(
        `DEK was wrapped with KEK v${params.version} (scrypt N=${params.N}), migrating to v${CURRENT_KEK_PARAMS.version}`,
      );
      return migrate_dek(storage, passphrase, tenant_id, dek);
    } catch {
      /* params didn't match, try next */
    }
  }

  throw new Error(
    'Failed to unwrap DEK with any known KEK version. ' +
      'Check encryption_passphrase or delete _meta/dek.enc to regenerate (existing data will be lost).',
  );
}

/** Re-wraps a DEK with the current KEK params and persists both the DEK and params. */
async function migrate_dek(
  storage: ObjectStorage,
  passphrase: string,
  tenant_id: string,
  dek: Buffer,
): Promise<{ dek: Buffer; key_service: EnvelopeKeyService }> {
  const new_svc = await EnvelopeKeyService.create(passphrase, tenant_id, CURRENT_KEK_PARAMS);
  const re_wrapped = new_svc.wrap_dek(dek);
  await storage.put(DEK_META_KEY, re_wrapped);
  await save_kek_params(storage, CURRENT_KEK_PARAMS);
  logger.info(
    `KEK migrated to v${CURRENT_KEK_PARAMS.version} (scrypt N=${CURRENT_KEK_PARAMS.N}) for tenant ${tenant_id}`,
  );
  return { dek, key_service: new_svc };
}
