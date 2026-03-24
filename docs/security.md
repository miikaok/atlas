# Security Model

Atlas uses **envelope encryption** to isolate tenants cryptographically. This page explains the full encryption architecture, what is protected, what is not, and the security properties you can rely on.

## Key Hierarchy

```
Master passphrase (env var)
    |
    v
scrypt(passphrase, tenant_id, N=16384, r=8, p=1)  -->  KEK (256-bit, per-tenant)
    |
    v
KEK wraps/unwraps a random DEK (AES-256-GCM)
    |
    v
DEK encrypts all data + manifests for that tenant
```

### Why Envelope Encryption

Envelope encryption separates the key that protects your data (DEK) from the key that protects that key (KEK). This means:

- The DEK is a random 256-bit key with maximum entropy -- it does not depend on passphrase strength.
- The KEK is derived from your passphrase and only used to wrap/unwrap the DEK.
- If you need to change the passphrase in the future, only the DEK wrapper needs to be re-encrypted -- not every object in storage.

### KEK Derivation: scrypt

The KEK is derived using **scrypt**, a memory-hard key derivation function designed to resist brute-force attacks from GPUs and custom hardware (ASICs). Unlike simpler hash functions, scrypt requires a large amount of RAM for each derivation attempt, making parallel attacks expensive.

Parameters used by Atlas:

| Parameter       | Value               | Purpose                                   |
| --------------- | ------------------- | ----------------------------------------- |
| N (cost)        | 16384               | CPU/memory cost factor (2^14 iterations)  |
| r (block size)  | 8                   | Memory usage multiplier                   |
| p (parallelism) | 1                   | Sequential derivation (no parallel lanes) |
| Salt            | `tenant_id` string  | Ensures different KEKs per tenant         |
| Output          | 32 bytes (256 bits) | AES-256 key length                        |

The **tenant ID as salt** is a deliberate design choice. It means that the same master passphrase used across multiple tenants produces completely different KEKs for each tenant. An attacker who compromises one tenant's KEK gains nothing toward decrypting another tenant's data.

### DEK: Data Encryption Key

- **Generated once** per tenant: a cryptographically random 256-bit key.
- **Stored wrapped** (encrypted with the KEK) at `_meta/dek.enc` in the tenant's S3 bucket.
- **Never stored in plaintext** -- only exists in memory during a backup/restore run.
- **Re-derived on every run**: Atlas reads `_meta/dek.enc`, derives the KEK from the passphrase, unwraps the DEK, and holds it in memory for the session.

::: danger Passphrase Is Irrecoverable
There is **no key rotation mechanism** and **no recovery path**. If you lose the passphrase, the DEK cannot be unwrapped, and all data for that tenant is permanently inaccessible. Changing the passphrase without migrating the wrapped DEK will cause GCM authentication failures when Atlas tries to unwrap `_meta/dek.enc`.

**Treat the passphrase as critically as the data itself.** Store it in a password manager, a sealed envelope in a safe, or a secrets management system -- but never lose it.
:::

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

| Data                     | Encrypted | Notes                                                                                     |
| ------------------------ | --------- | ----------------------------------------------------------------------------------------- |
| Email message bodies     | Yes       | Stored as encrypted JSON under `data/{mailbox}/{sha256}`                                  |
| Attachments              | Yes       | Stored as encrypted blobs under `attachments/{mailbox}/{sha256}`                          |
| OneDrive files           | Yes       | Stored as encrypted blobs under `onedrive/data/{owner}/{sha256}`                          |
| OneDrive manifests       | Yes       | Stored under `onedrive/manifests/{owner}/{snapshot}.json`                                 |
| OneDrive version indexes | Yes       | Stored under `onedrive/index/{owner}/files/{file_id}.json`                                |
| OneDrive delta cursors   | Yes       | Stored under `onedrive/_meta/{owner}/delta.json`                                          |
| Manifests                | Yes       | Contains subjects, folder names, delta URLs, checksums                                    |
| Wrapped DEK              | Yes       | `_meta/dek.enc` is encrypted with the KEK                                                 |
| S3 object metadata       | **No**    | `x-message-id` and `x-plaintext-sha256` headers are visible to anyone with S3 read access |

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

`atlas verify` checks **message body entries** listed in mailbox manifests. `atlas onedrive verify` checks OneDrive snapshot entries and validates per-file version index linkage. Attachments and other encrypted blobs are implicitly protected by GCM authentication during any decrypt operation (backup, restore, save).

### Content-MD5 on Uploads

Every object uploaded to S3 includes a `Content-MD5` header computed from the **ciphertext** (not the plaintext). This is a transport integrity check -- if a network error corrupts the data in flight, S3 will reject the upload with a checksum mismatch. This is separate from the application-layer SHA-256, which validates the original plaintext content.
