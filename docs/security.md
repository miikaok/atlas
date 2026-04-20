# Security Model

Atlas uses **envelope encryption** to isolate tenants cryptographically. This page explains the full encryption architecture, what is protected, what is not, and the security properties you can rely on.

## Key Hierarchy

```
Master passphrase (env var)
    |
    v
scrypt(passphrase, [len][tenant_id][random_salt], N=65536, r=8, p=1)  -->  KEK (256-bit, per wrap)
    |
    v
KEK wraps/unwraps a random DEK (AES-256-GCM with header as AAD)
    |
    v
DEK encrypts all data + manifests for that tenant
```

The effective scrypt salt is a **length-prefixed domain separator**: `[2-byte tenant_id length, big-endian][tenant_id UTF-8][32 random bytes from CSPRNG]`. The random salt is stored inside the wrapped DEK blob at `_meta/dek.enc`; the tenant ID is not stored in the blob (it is already known from the bucket context). This ensures that even with the same passphrase, each tenant derives a unique KEK -- an attacker who compromises one tenant's blob cannot use it to attack another tenant's DEK. The blob format is versioned so future releases can add new KDF algorithms (e.g. Argon2) without ambiguity.

### Why Envelope Encryption

Envelope encryption separates the key that protects your data (DEK) from the key that protects that key (KEK). This means:

- The DEK is a random 256-bit key with maximum entropy -- it does not depend on passphrase strength.
- The KEK is derived from your passphrase and only used to wrap/unwrap the DEK.
- If you need to change the passphrase in the future, only the DEK wrapper needs to be re-encrypted -- not every object in storage.

### KEK Derivation: scrypt

The KEK is derived using **scrypt**, a memory-hard key derivation function designed to resist brute-force attacks from GPUs and custom hardware (ASICs). Unlike simpler hash functions, scrypt requires a large amount of RAM for each derivation attempt, making parallel attacks expensive. With N=65536 and r=8, Node/OpenSSL needs a raised `maxmem` ceiling (~128 MiB) per unwrap; expect a short CPU+memory spike when loading `_meta/dek.enc`.

Parameters used by Atlas (scrypt strategy, `kdf_id = 0x01` in the wrapped DEK blob):


| Parameter       | Value                                                | Purpose                                                                         |
| --------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------- |
| N (cost)        | 65536 (minimum enforced: 16384)                      | CPU/memory cost factor (2^16 iterations; OWASP-aligned for sensitive workloads) |
| r (block size)  | 8                                                    | Memory usage multiplier                                                         |
| p (parallelism) | 1                                                    | Sequential derivation (no parallel lanes)                                       |
| Salt            | `[2-byte len][tenant_id][32 random bytes]`, per wrap | Domain-separated per tenant; random component stored in the blob                |
| Output          | 32 bytes (256 bits)                                  | AES-256 key length                                                              |


**Tenant isolation** comes from three layers: separate S3 buckets per tenant, separate random DEKs, and tenant-scoped KEK derivation. The passphrase is global to the Atlas deployment, but each tenant's KEK is derived with a length-prefixed domain separator that includes the tenant ID and a unique random salt. An attacker who obtains one tenant's wrapped DEK blob cannot use it to derive another tenant's KEK -- each derivation is cryptographically bound to its tenant. The enforced minimum N=16384 ensures that even with full knowledge of the code, tenant IDs, and blob contents, brute-forcing the passphrase through scrypt remains costly.

### Wrapped DEK blob format (v1)

`_meta/dek.enc` is not raw AES-GCM output. It is a **versioned envelope**:

```
[1 byte: format version 0x01]                              ┐
[1 byte: KDF id, e.g. 0x01 = scrypt]                       │  header (used as GCM AAD)
[2 bytes: KDF params length, big-endian]                    │
[variable: KDF-specific params — for scrypt: N, r, p, salt] ┘
[12-byte IV][16-byte GCM tag][ciphertext]  ← AES-256-GCM encryption of the DEK
```

The entire header (version through KDF params) is passed as **Additional Authenticated Data (AAD)** to AES-256-GCM. This means tampering with any header field -- the version byte, the KDF identifier, the scrypt parameters, or the salt -- is detected by the GCM authentication tag and causes decryption to fail. An attacker with S3 write access cannot downgrade KDF parameters or swap salts without being detected.

New KDF algorithms can be registered in code alongside scrypt; the outer length-prefixed header keeps parsing unambiguous. Application data ciphertext format (`[IV][tag][ciphertext]`) is unchanged.

### DEK: Data Encryption Key

- **Generated once** per tenant: a cryptographically random 256-bit key.
- **Stored wrapped** (encrypted with the KEK) at `_meta/dek.enc` in the tenant's S3 bucket.
- **Never stored in plaintext** -- only exists in memory during a backup/restore run.
- **Re-derived on every run**: Atlas reads `_meta/dek.enc`, parses the versioned header, derives the KEK from the passphrase and embedded KDF parameters, unwraps the DEK, and holds it in memory for the session.

::: danger Passphrase Is Irrecoverable
There is **no recovery path** if the passphrase is lost: the DEK cannot be unwrapped. Changing the passphrase without re-wrapping `_meta/dek.enc` (or restoring from a backup of the wrapped file under the old passphrase) will cause GCM authentication failures.

**Treat the passphrase as critically as the data itself.** Store it in a password manager, a sealed envelope in a safe, or a secrets management system -- but never lose it.
:::

### Passphrase Strength

The encryption scheme follows Kerckhoffs's principle: security rests entirely on the passphrase, not on secrecy of the code, algorithms, or parameters. The source code is public, tenant IDs are discoverable, and the blob header (including scrypt parameters and the random salt) is stored in plaintext. The only secret is the passphrase.

With scrypt at N=65536 and r=8, each brute-force guess costs ~64 MiB of RAM and significant CPU. Atlas warns at startup if the passphrase is shorter than 14 characters. For production deployments:

- Use **at least 5 random words** (diceware) or **20+ random characters** with mixed case, digits, and symbols.
- A passphrase shorter than 14 characters is vulnerable to brute-force with commodity GPUs.
- Store the passphrase in a password manager or secrets management system (e.g. HashiCorp Vault, AWS Secrets Manager).

## Encryption Details

### Algorithm: AES-256-GCM

Every encrypt operation uses **AES-256-GCM** (Galois/Counter Mode), which provides both confidentiality and authenticity in a single pass:

- **Confidentiality**: the plaintext is encrypted and unreadable without the key.
- **Authenticity**: a 16-byte authentication tag is computed over the ciphertext, meaning any tampering (even a single flipped bit) is detected on decryption and causes an immediate failure.

### Ciphertext Format

```
[12-byte IV][16-byte GCM auth tag][ciphertext]
```

Every encrypt operation generates a **fresh random 12-byte IV** (initialization vector). This is critical for GCM security -- reusing an IV with the same key would be catastrophic, potentially exposing the XOR of two plaintexts and compromising the authentication key. Atlas generates a new random IV for every single object it encrypts.

### What Is Encrypted at Rest


| Data                 | Encrypted | Notes                                                                                     |
| -------------------- | --------- | ----------------------------------------------------------------------------------------- |
| Email message bodies | Yes       | Stored as encrypted JSON under `data/{mailbox}/{sha256}`                                  |
| Attachments          | Yes       | Stored as encrypted blobs under `attachments/{mailbox}/{sha256}`                          |
| Manifests            | Yes       | Contains subjects, folder names, delta URLs, checksums                                    |
| Wrapped DEK          | Yes       | `_meta/dek.enc` is encrypted with the KEK                                                 |
| S3 object metadata   | **No**    | `x-message-id` and `x-plaintext-sha256` headers are visible to anyone with S3 read access |


The S3 object metadata is intentionally not encrypted because it is used for deduplication checks without requiring decryption. However, this means that the **Graph message ID** and **plaintext SHA-256 hash** of each message are visible to anyone who can list or read S3 object metadata. The message content itself remains encrypted.

Manifests deserve special attention: they contain email subjects, folder display names, and Microsoft Graph delta URLs. All of this metadata is encrypted with the same DEK, so subject lines and folder names are never exposed at rest in the S3 bucket.

## Integrity Validation

Atlas validates data integrity at three independent layers. Each layer catches a different class of failure:


| Layer         | Mechanism                           | What It Catches                                          | When                                 |
| ------------- | ----------------------------------- | -------------------------------------------------------- | ------------------------------------ |
| **Plaintext** | SHA-256 checksum stored in manifest | Corruption before encryption, application bugs           | Backup, verify, save                 |
| **Transport** | `Content-MD5` header on S3 PUT      | Network corruption during upload (bit flips, truncation) | Every upload (S3 rejects mismatches) |
| **At-rest**   | AES-256-GCM authentication tag      | Storage-level tampering or corruption                    | Every decrypt operation              |


### How Verification Works

When you run `atlas verify`, Atlas performs a full integrity check for a snapshot:

1. Downloads each encrypted object from S3.
2. Decrypts it with the tenant DEK (GCM auth tag validates ciphertext integrity).
3. Computes SHA-256 of the decrypted plaintext.
4. Compares against the checksum stored in the manifest using **constant-time comparison** (`timingSafeEqual`) to prevent timing attacks.

Currently, `atlas verify` checks **message body entries** listed in the manifest. Attachments are implicitly protected by GCM authentication during any decrypt operation (backup, restore, save).

### Content-MD5 on Uploads

Every object uploaded to S3 includes a `Content-MD5` header computed from the **ciphertext** (not the plaintext). This is a transport integrity check -- if a network error corrupts the data in flight, S3 will reject the upload with a checksum mismatch. This is separate from the application-layer SHA-256, which validates the original plaintext content.

## Replication Security

Atlas replication uses a **shared encryption model**: all storage targets share the same master passphrase and the same per-tenant DEK, so ciphertext is copied byte-for-byte without decryption or re-encryption. Because one passphrase protects all copies, S3 access credentials must be separate per target -- an attacker who compromises one target's S3 credentials cannot reach other targets. A replica marker (`_meta/replica.marker`) on each target prevents accidental direct backup writes to replicas. Replication status sidecars are themselves encrypted with the tenant DEK, so target endpoints and checksums are not exposed at rest.

For the full operational detail -- including DEK mismatch protection, the primary-is-truth principle, and disaster recovery via `atlas rehydrate` -- see [Replication: Shared Encryption Model](/operations/replication#shared-encryption-model).