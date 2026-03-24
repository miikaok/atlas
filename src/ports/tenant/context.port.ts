import type { ObjectStorage } from '@/ports/storage/object-storage.port';

/** Tenant-scoped object storage accessor. */
export interface TenantStorageContext {
  readonly tenant_id: string;
  readonly storage: ObjectStorage;
}

/** Streaming cipher returned by create_cipher(). */
export interface StreamingCipher {
  update(chunk: Buffer): Buffer;
  final(): Buffer;
  getAuthTag(): Buffer;
}

/** Tenant-scoped encryption/decryption operations. */
export interface TenantCryptoContext {
  /** Encrypts plaintext with this tenant's data encryption key. */
  encrypt(data: Buffer): Buffer;

  /** Decrypts ciphertext with this tenant's data encryption key. */
  decrypt(data: Buffer): Buffer;

  /** Creates a fresh AES-256-GCM cipher + IV for streaming encryption. */
  create_cipher(): { cipher: StreamingCipher; iv: Buffer };
}

/** Bundles tenant-scoped storage and encryption for a single tenant. */
export interface TenantContext extends TenantStorageContext, TenantCryptoContext {}

/** Factory that initializes per-tenant infrastructure (bucket, DEK) on demand. */
export interface TenantContextFactory {
  create(tenant_id: string): Promise<TenantContext>;
}
