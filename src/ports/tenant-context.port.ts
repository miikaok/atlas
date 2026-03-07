import type { ObjectStorage } from '@/ports/object-storage.port';

/** Bundles tenant-scoped storage and encryption for a single tenant. */
export interface TenantContext {
  readonly tenant_id: string;
  readonly storage: ObjectStorage;

  /** Encrypts plaintext with this tenant's data encryption key. */
  encrypt(data: Buffer): Buffer;

  /** Decrypts ciphertext with this tenant's data encryption key. */
  decrypt(data: Buffer): Buffer;
}

/** Factory that initializes per-tenant infrastructure (bucket, DEK) on demand. */
export interface TenantContextFactory {
  create(tenant_id: string): Promise<TenantContext>;
}

export const TENANT_CONTEXT_FACTORY_TOKEN = Symbol.for('TenantContextFactory');
