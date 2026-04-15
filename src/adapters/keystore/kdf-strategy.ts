import { randomBytes, scryptSync } from 'node:crypto';

/** KDF identifier for scrypt (versioned DEK blob v1). */
export const KDF_SCRYPT = 0x01;

const KEY_LENGTH = 32;
/** OWASP-recommended cost for sensitive workloads (2^16). */
const SCRYPT_N = 65536;
const SCRYPT_R = 8;
const SCRYPT_P = 1;

/** OpenSSL default maxmem (32 MiB) is too small for N=65536, r=8 (~64 MiB required). */
const SCRYPT_MAXMEM = 128 * 1024 * 1024;
/** Upper bound for N to prevent a crafted blob from allocating unbounded memory. */
const SCRYPT_N_MAX = 1 << 20;

/** Fixed layout: N(4 BE) + r(1) + p(1) + salt(32). */
export const SCRYPT_PARAMS_LENGTH = 38;

/**
 * Pluggable KDF for KEK derivation. Register new implementations in
 * `KDF_STRATEGIES` when adding algorithms (e.g. argon2).
 */
export interface KdfStrategy {
  readonly kdf_id: number;
  derive_kek(passphrase: string, params: Buffer): Buffer;
  /** Produces a fresh params block for `wrap_dek` (includes random salt). */
  generate_params(): Buffer;
}

/** scrypt-based KEK derivation with per-wrap random salt stored in the blob. */
export class ScryptKdfStrategy implements KdfStrategy {
  readonly kdf_id = KDF_SCRYPT;

  /** @inheritdoc */
  derive_kek(passphrase: string, params: Buffer): Buffer {
    if (params.length !== SCRYPT_PARAMS_LENGTH) {
      throw new Error(
        `Invalid scrypt params length: expected ${SCRYPT_PARAMS_LENGTH}, got ${params.length}`,
      );
    }
    const N = params.readUInt32BE(0);
    const r = params.readUInt8(4);
    const p = params.readUInt8(5);
    validate_scrypt_params(N, r, p);
    const salt = params.subarray(6, SCRYPT_PARAMS_LENGTH);
    return scryptSync(passphrase, salt, KEY_LENGTH, { N, r, p, maxmem: SCRYPT_MAXMEM });
  }

  /** @inheritdoc */
  generate_params(): Buffer {
    const salt = randomBytes(32);
    const buf = Buffer.alloc(SCRYPT_PARAMS_LENGTH);
    buf.writeUInt32BE(SCRYPT_N, 0);
    buf.writeUInt8(SCRYPT_R, 4);
    buf.writeUInt8(SCRYPT_P, 5);
    salt.copy(buf, 6);
    return buf;
  }
}

/** Rejects params that would cause excessive memory use or are clearly invalid. */
function validate_scrypt_params(cost_n: number, block_r: number, parallel_p: number): void {
  if (cost_n === 0 || (cost_n & (cost_n - 1)) !== 0) {
    throw new Error(`scrypt N must be a power of 2, got ${cost_n}`);
  }
  if (cost_n > SCRYPT_N_MAX) {
    throw new Error(`scrypt N exceeds maximum (${cost_n} > ${SCRYPT_N_MAX})`);
  }
  if (block_r < 1 || block_r > 255) {
    throw new Error(`scrypt r out of range (${block_r})`);
  }
  if (parallel_p < 1 || parallel_p > 255) {
    throw new Error(`scrypt p out of range (${parallel_p})`);
  }
}

const scrypt_strategy = new ScryptKdfStrategy();

/** Default strategy used for new `wrap_dek` output. */
export const DEFAULT_KDF_STRATEGY: KdfStrategy = scrypt_strategy;

/** Lookup by `kdf_id` byte in the versioned DEK blob. */
export const KDF_STRATEGIES: ReadonlyMap<number, KdfStrategy> = new Map([
  [KDF_SCRYPT, scrypt_strategy],
]);
