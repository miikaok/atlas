import { inject, injectable } from 'inversify';
import type { S3Client } from '@aws-sdk/client-s3';
import { S3_CLIENT_TOKEN } from '@/adapters/s3-client.factory';
import { S3ObjectStorage } from '@/adapters/s3-object-storage.adapter';
import { ensure_bucket_exists } from '@/adapters/s3-bucket-manager';
import { tenant_bucket_name } from '@/adapters/tenant-bucket-name';
import {
  EnvelopeKeyService,
  CURRENT_KEK_PARAMS,
  load_dek_with_migration,
  save_kek_params,
  ATLAS_CONFIG_TOKEN,
  logger,
} from '@atlas/core';
import type { AtlasConfig } from '@atlas/core';
import type { TenantContext, TenantContextFactory } from '@atlas/types';

const DEK_META_KEY = '_meta/dek.enc';

@injectable()
export class DefaultTenantContextFactory implements TenantContextFactory {
  constructor(
    @inject(S3_CLIENT_TOKEN) private readonly _s3: S3Client,
    @inject(ATLAS_CONFIG_TOKEN) private readonly _config: AtlasConfig,
  ) {}

  /** Initializes a tenant context with bucket, DEK, and crypto bindings. */
  async create(tenant_id: string): Promise<TenantContext> {
    const bucket = tenant_bucket_name(tenant_id);
    await ensure_bucket_exists(this._s3, bucket);

    const storage = new S3ObjectStorage(this._s3, bucket);
    const { dek, key_service } = await this.load_or_create_dek(storage, tenant_id);

    return {
      tenant_id,
      storage,
      encrypt: (data: Buffer): Buffer => key_service.encrypt(data, dek),
      decrypt: (data: Buffer): Buffer => key_service.decrypt(data, dek),
      create_cipher: () => key_service.create_encrypt_cipher(dek),
      create_decipher: (iv: Buffer, auth_tag: Buffer) =>
        key_service.create_decrypt_decipher(dek, iv, auth_tag),
    };
  }

  /** Loads an existing DEK (with versioned KEK migration) or generates a new one. */
  private async load_or_create_dek(
    storage: S3ObjectStorage,
    tenant_id: string,
  ): Promise<{ dek: Buffer; key_service: EnvelopeKeyService }> {
    const dek_exists = await storage.exists(DEK_META_KEY);

    if (dek_exists) {
      return load_dek_with_migration(storage, this._config.encryption_passphrase, tenant_id);
    }

    logger.info(`Generating new encryption key for tenant ${tenant_id}`);
    const key_service = await EnvelopeKeyService.create(
      this._config.encryption_passphrase,
      tenant_id,
    );
    const dek = key_service.generate_dek();
    await storage.put(DEK_META_KEY, key_service.wrap_dek(dek));
    await save_kek_params(storage, CURRENT_KEK_PARAMS);
    return { dek, key_service };
  }
}
