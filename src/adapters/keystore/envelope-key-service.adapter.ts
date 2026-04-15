import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { DEFAULT_KDF_STRATEGY, KDF_STRATEGIES } from '@/adapters/keystore/kdf-strategy';
import { parse_dek_blob, serialize_dek_blob } from '@/adapters/keystore/dek-blob-codec';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const KEY_LENGTH = 32;

/**
 * Envelope encryption using AES-256-GCM.
 *
 * - A master passphrase derives a KEK per wrap via a registered KDF strategy (scrypt v1).
 * - A random DEK is generated per tenant, encrypted ("wrapped") with the KEK.
 * - Wrapped DEK format is versioned; see `docs/security.md`.
 * - All tenant data is encrypted with the DEK.
 */
export class EnvelopeKeyService {
  private readonly _passphrase: string;

  constructor(passphrase: string) {
    this._passphrase = passphrase;
  }

  /** Encrypts plaintext using the given DEK. */
  encrypt(data: Buffer, dek: Buffer): Buffer {
    return aes_gcm_encrypt(data, dek);
  }

  /** Decrypts ciphertext using the given DEK. Throws on tampered data. */
  decrypt(data: Buffer, dek: Buffer): Buffer {
    return aes_gcm_decrypt(data, dek);
  }

  /** Generates a fresh random 256-bit DEK. */
  generate_dek(): Buffer {
    return randomBytes(KEY_LENGTH);
  }

  /** Encrypts (wraps) a DEK with a KEK derived from the passphrase and random salt (v1 blob). */
  wrap_dek(dek: Buffer): Buffer {
    const strategy = DEFAULT_KDF_STRATEGY;
    const params = strategy.generate_params();
    const kek = strategy.derive_kek(this._passphrase, params);
    const encrypted = aes_gcm_encrypt(dek, kek);
    return serialize_dek_blob({ kdf_id: strategy.kdf_id, kdf_params: params }, encrypted);
  }

  /** Decrypts (unwraps) a wrapped DEK using the passphrase and blob metadata. */
  unwrap_dek(wrapped: Buffer): Buffer {
    const { header, encrypted_dek } = parse_dek_blob(wrapped);
    const strategy = KDF_STRATEGIES.get(header.kdf_id);
    if (!strategy) {
      throw new Error(`Unknown KDF id in wrapped DEK: ${header.kdf_id}`);
    }
    const kek = strategy.derive_kek(this._passphrase, header.kdf_params);
    return aes_gcm_decrypt(encrypted_dek, kek);
  }
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
