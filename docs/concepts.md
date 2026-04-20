# Concepts

A mental model for how Atlas works before diving into CLI flags and configuration options. These concepts appear frequently in error messages, CLI output, and the rest of the documentation.

## What Is a Snapshot?

A **snapshot** is a point-in-time record of a mailbox's backed-up state. It is not a full copy of all email -- it is a **manifest file** that lists every message and attachment that was backed-up at a given moment, along with metadata: message IDs, folder names, SHA-256 checksums, and references to the data objects stored in S3.

The actual message data (ciphertext blobs) lives separately in S3, organized by content address. Multiple snapshots can reference the same data objects -- if a message was backed up last week and is still in the mailbox today, both snapshots point to the same S3 object. The object is stored once.

A snapshot is **immutable once written**. Atlas never modifies a snapshot after creation. If Object Lock is enabled on the bucket, the manifest file is locked against deletion for the retention period.

When you run `atlas list -s <snapshot-id>`, you are reading the manifest. When you run `atlas restore -s <snapshot-id>`, Atlas reads the manifest to find which objects to download, decrypts them, and pushes them back to Microsoft Graph.

## What Does Deduplication Mean?

Atlas uses **SHA-256 content addressing** to deduplicate data. Before writing a message or attachment to S3, Atlas computes the SHA-256 hash of the plaintext content and uses that hash as the storage key. If an object with that key already exists in the bucket, the write is skipped -- the existing object is shared.

In practice, this means:

- **Same message in multiple mailboxes**: a forwarded email or shared attachment is stored once, regardless of how many mailboxes received it.
- **Same message in multiple snapshots**: a message that has not changed between two backups appears in both manifests but occupies storage space only once.
- **Deduplication scope is per-tenant**: objects are deduplicated within a single tenant's bucket. Two separate tenants with their own buckets and encryption keys do not share objects.

This also explains why `atlas delete -s <snapshot-id>` only removes the manifest, not the data objects: other snapshots may still reference the same objects. `atlas delete -m <mailbox>` removes all data objects for a mailbox because it is certain no other mailbox's snapshots reference them.

## Key Terms Glossary

| Term | Definition |
| ---- | ---------- |
| **DEK** (Data Encryption Key) | A 256-bit symmetric key generated once per tenant and stored encrypted in the bucket at `_meta/dek.enc`. All message and attachment ciphertext in the bucket is encrypted with this key using AES-256-GCM. |
| **KEK** (Key Encryption Key) | A key derived from the master passphrase using scrypt (N=16384, r=8, p=1). The KEK is used to wrap (encrypt) the DEK -- it is never stored anywhere, only recomputed on demand from the passphrase. |
| **Delta link** | A Microsoft Graph API cursor that marks the point in a mailbox's change history where the last backup ended. On the next backup, Atlas uses the delta link to request only changes since that point, making incremental syncs fast. Delta links are stored per-folder in the snapshot manifest. |
| **Manifest** | A JSON file stored in S3 that describes a snapshot: list of backed-up messages and attachments, their storage keys, checksums, folder assignments, and delta links. One manifest file per snapshot. |
| **Snapshot** | A point-in-time backup record, consisting of a manifest file and the data objects it references. Identified by a short hash ID (e.g. `snap-a3b2c1`). |
| **Tenant** | An Microsoft 365 organization, identified by its Azure AD tenant ID (a UUID). Each tenant gets its own S3 bucket prefix, its own DEK, and its own set of mailbox backups. |
| **Replica marker** | A file (`_meta/replica.marker`) written to secondary storage targets on first replication. Atlas checks for this file to detect when a backup command is accidentally run against a replica instead of primary storage. |
