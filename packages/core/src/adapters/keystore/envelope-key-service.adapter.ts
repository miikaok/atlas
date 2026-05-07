import {
  scrypt,
  randomBytes,
  createCipheriv,
  createDecipheriv,
  type CipherGCM,
  type DecipherGCM,
} from 'node:crypto';
import { promisify } from 'node:util';

/** Promisified `scrypt`; upstream typings omit `keylen` as a distinct argument. */
const scrypt_async = promisify(scrypt) as (
  password: string | Buffer | NodeJS.ArrayBufferView,
  salt: string | Buffer | NodeJS.ArrayBufferView,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem?: number },
) => Promise<Buffer>;

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const KEY_LENGTH = 32;
const SCRYPT_MAXMEM = 64 * 1024 * 1024;

/** Versioned scrypt parameters used to derive the KEK. */
export interface KekParams {
  readonly version: number;
  readonly N: number;
  readonly r: number;
  readonly p: number;
}

/** Current (latest) KEK derivation parameters. Bump version when changing. */
export const CURRENT_KEK_PARAMS: KekParams = { version: 2, N: 32768, r: 8, p: 1 };

/**
 * Ordered history of all known KEK parameter sets, newest first.
 * Used for fallback when no `_meta/kek_params.json` exists yet.
 */
export const KEK_PARAMS_HISTORY: readonly KekParams[] = [
  CURRENT_KEK_PARAMS,
  { version: 1, N: 16384, r: 8, p: 1 },
];

/**
 * Envelope encryption using AES-256-GCM.
 *
 * - A master passphrase + tenant_id derive a unique KEK per tenant (scrypt).
 * - A random DEK is generated per tenant, encrypted ("wrapped") with the KEK.
 * - All tenant data is encrypted with the DEK.
 *
 * Encrypted format: [12-byte IV] [16-byte auth tag] [ciphertext]
 */
export class EnvelopeKeyService {
  private constructor(private readonly _kek: Buffer) {}

  /** Async factory — derives KEK using the given (or current) params. */
  static async create(
    passphrase: string,
    tenant_id: string,
    params: KekParams = CURRENT_KEK_PARAMS,
  ): Promise<EnvelopeKeyService> {
    const kek = await derive_kek(passphrase, tenant_id, params);
    return new EnvelopeKeyService(kek);
  }

  /** Encrypts plaintext using the given DEK. */
  encrypt(data: Buffer, dek: Buffer): Buffer {
    return aes_gcm_encrypt(data, dek);
  }

  /** Decrypts ciphertext using the given DEK. Throws on tampered data. */
  decrypt(data: Buffer, dek: Buffer): Buffer {
    return aes_gcm_decrypt(data, dek);
  }

  /**
   * Creates a streaming AES-256-GCM cipher using the DEK (same parameters as
   * {@link EnvelopeKeyService.encrypt}); finalize with auth tag for the envelope format.
   */
  create_encrypt_cipher(dek: Buffer): { cipher: CipherGCM; iv: Buffer } {
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, dek, iv, { authTagLength: AUTH_TAG_LENGTH });
    return { cipher, iv };
  }

  /** Creates a streaming AES-256-GCM decipher initialized with IV and auth tag. */
  create_decrypt_decipher(dek: Buffer, iv: Buffer, auth_tag: Buffer): DecipherGCM {
    const decipher = createDecipheriv(ALGORITHM, dek, iv, { authTagLength: AUTH_TAG_LENGTH });
    decipher.setAuthTag(auth_tag);
    return decipher;
  }

  /** Generates a fresh random 256-bit DEK. */
  generate_dek(): Buffer {
    return randomBytes(KEY_LENGTH);
  }

  /** Encrypts (wraps) a DEK with this tenant's KEK. */
  wrap_dek(dek: Buffer): Buffer {
    return aes_gcm_encrypt(dek, this._kek);
  }

  /** Decrypts (unwraps) a wrapped DEK with this tenant's KEK. */
  unwrap_dek(wrapped: Buffer): Buffer {
    return aes_gcm_decrypt(wrapped, this._kek);
  }
}

/** Derives a 256-bit KEK from passphrase + tenant_id using the given scrypt params. */
export async function derive_kek(
  passphrase: string,
  tenant_id: string,
  params: KekParams = CURRENT_KEK_PARAMS,
): Promise<Buffer> {
  return await scrypt_async(passphrase, tenant_id, KEY_LENGTH, {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem: SCRYPT_MAXMEM,
  });
}

/** AES-256-GCM encrypt. Returns: [IV (12)] [auth tag (16)] [ciphertext]. */
function aes_gcm_encrypt(plaintext: Buffer, key: Buffer): Buffer {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]);
}

/** AES-256-GCM decrypt. Expects format: [IV (12)] [auth tag (16)] [ciphertext]. */
function aes_gcm_decrypt(blob: Buffer, key: Buffer): Buffer {
  if (blob.length < IV_LENGTH + AUTH_TAG_LENGTH) {
    throw new Error('Ciphertext too short to contain IV and auth tag');
  }

  const iv = blob.subarray(0, IV_LENGTH);
  const tag = blob.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = blob.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

  const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}
