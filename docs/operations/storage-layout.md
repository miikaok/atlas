# Storage Layout

Each tenant gets its own S3 bucket named `atlas-{tenant_id}`:

```
atlas-{tenant_id}/
├── _meta/
│   └── dek.enc                         # wrapped DEK (encrypted with KEK)
├── data/
│   └── {mailbox_id}/
│       ├── {sha256_a}                  # encrypted message (content-addressed)
│       └── ...
├── attachments/
│   └── {mailbox_id}/
│       ├── {sha256_x}                  # encrypted attachment (content-addressed)
│       └── ...
└── manifests/
    └── {mailbox_id}/
        ├── {snapshot_id_1}.json        # encrypted manifest
        └── {snapshot_id_2}.json
```

## Per-Tenant Bucket Isolation

Every tenant is stored in a completely separate S3 bucket. This is a deliberate security boundary: compromising one bucket's S3 credentials does **not** grant access to any other tenant's data. Each bucket has its own ACLs, its own encryption key (`dek.enc`), and can have its own Object Lock and lifecycle policies.

For managed service providers backing up multiple tenants, this isolation means you can grant per-tenant access to bucket contents without exposing cross-tenant data.

## Key Paths

| Prefix | Contents | Security Notes |
| --- | --- | --- |
| `_meta/dek.enc` | Wrapped data encryption key (one per tenant) | **Most critical object** -- losing this means losing access to all tenant data |
| `data/{mailbox}/` | Encrypted email messages, addressed by SHA-256 | Content is encrypted; S3 metadata is not |
| `attachments/{mailbox}/` | Encrypted attachments, addressed by SHA-256 | Content is encrypted; S3 metadata is not |
| `manifests/{mailbox}/` | Encrypted snapshot manifests (JSON) | Contains subjects, folder names, delta URLs -- all encrypted |

### The `_meta/dek.enc` Object

This is the single most important object in the entire bucket. It contains the **Data Encryption Key (DEK)** wrapped (encrypted) with the KEK derived from your passphrase. Without this file:

- No message can be decrypted
- No manifest can be read
- No restore is possible

If `_meta/dek.enc` is deleted or corrupted, all data in the bucket becomes permanently inaccessible (assuming you do not have a separate backup of the DEK). Consider applying additional protection to this prefix:

- S3 bucket policies that restrict delete operations on `_meta/*`
- Object Lock with extended retention on this specific prefix
- Regular verification that the file exists and is accessible

## Content-Addressed Storage

Messages and attachments are stored using their **SHA-256 hash** as the object key (e.g., `data/{mailbox}/a1b2c3d4...`). This is the hash of the **plaintext** content, computed before encryption.

This design provides automatic deduplication: if the same email exists in multiple snapshots (common with incremental backups), it is stored only once. The manifest references the hash, and any snapshot that includes that message points to the same S3 object.

Content-addressed storage also makes integrity verification straightforward -- decrypt the object, hash the result, and compare against the key. If they match, the content is exactly what was originally backed up.

## S3 Object Metadata

Each uploaded object includes S3 metadata headers:

| Header | Value | Encrypted |
| --- | --- | --- |
| `x-amz-meta-x-message-id` | Microsoft Graph message ID | **No** -- visible to S3 access |
| `x-amz-meta-x-plaintext-sha256` | SHA-256 of original plaintext | **No** -- visible to S3 access |
| `Content-MD5` | MD5 of ciphertext (transport integrity) | N/A -- standard S3 header |

::: warning Metadata Visibility
S3 object metadata is **not encrypted**. Anyone with S3 read access (e.g., `s3:GetObject` or `s3:ListBucket` with metadata) can see the Graph message IDs and plaintext hashes. The message **content** is encrypted, but the metadata reveals that specific messages exist and their content hashes. This is a trade-off: metadata enables deduplication checks and integrity verification without decryption, but it leaks existence information.

For environments where even metadata exposure is unacceptable, restrict S3 access to the Atlas service account only and use network-level controls (VPC, firewall rules) to limit who can reach the S3 endpoint.
:::
