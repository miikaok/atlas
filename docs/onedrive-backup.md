# OneDrive Backup

Atlas backs up OneDrive files separately from Exchange mailboxes. While both workloads share the same encryption, storage, and tenant model, the backup mechanics differ significantly because OneDrive deals with files of arbitrary size (from kilobytes to hundreds of gigabytes) and uses a different Microsoft Graph delta API surface.

This page explains the OneDrive-specific architecture. For Exchange mailbox backup, see the [Delta Sync](/operations/delta-sync) and [CLI Commands](/reference/cli) pages.

## Quick Start

```bash
# Full initial backup
atlas onedrive backup -o user@company.com --full

# Incremental backup (uses saved delta cursor)
atlas onedrive backup -o user@company.com

# List snapshots
atlas onedrive list-snapshots -o user@company.com

# List versions of a specific file
atlas onedrive list-versions -o user@company.com -f /Documents/report.xlsx

# Verify a snapshot
atlas onedrive verify -s od-snap-1774380590401-358d88
```

## Permissions

OneDrive backup requires these Microsoft Graph **Application** permissions (with admin consent):

| Permission        | Purpose                                                 |
| ----------------- | ------------------------------------------------------- |
| `Files.Read.All`  | Read files and drive items across all users              |
| `Sites.Read.All`  | Discover drives (OneDrive drives are SharePoint-backed)  |

These are separate from the Exchange permissions (`Mail.Read`, `Mail.ReadWrite`, etc.). If your app registration only has mail permissions, OneDrive commands will fail with a clear error message listing the missing permissions.

## How OneDrive Delta Sync Works

OneDrive uses Microsoft Graph's [drive item delta API](https://learn.microsoft.com/en-us/graph/api/driveitem-delta), which is fundamentally different from the per-folder message delta used in Exchange backup:

| Aspect                | Exchange Backup                          | OneDrive Backup                             |
| --------------------- | ---------------------------------------- | ------------------------------------------- |
| **Delta scope**       | Per mailbox folder                       | Per drive (one delta link per user drive)    |
| **Item types**        | Messages only                            | Files and folders                            |
| **Change detection**  | Delta token + message content hash       | Delta token + eTag comparison               |
| **Delta state saved** | In the manifest per folder               | In an encrypted cursor file per owner        |
| **Cursor location**   | `manifests/{mailbox}/{snapshot}.json`    | `onedrive/_meta/{owner}/delta.json`          |

### Delta Cursor

The OneDrive delta cursor is stored as an encrypted JSON object at `onedrive/_meta/{owner}/delta.json`. It contains:

- **Delta links** per drive (the opaque `@odata.deltaLink` URLs from Microsoft Graph)
- **Previous file state** (path, name, eTag per file ID) for accurate change classification

This cursor is intentionally saved **last** in the persist sequence (after manifests and file indexes) so that a crash never advances the delta link past data that hasn't been recorded in a manifest. See [Crash Safety](#crash-safety) below.

### Change Classification

When the delta API returns an item, Atlas classifies the change by comparing against the previous cursor state:

| Classification | Condition                                                          |
| -------------- | ------------------------------------------------------------------ |
| `created`      | File ID has no previous state in the cursor                        |
| `updated`      | eTag changed, or eTag presence toggled (had eTag → lost it, or vice versa) |
| `moved`        | Parent path changed, but name and eTag unchanged                   |
| `renamed`      | File name changed, but parent path and eTag unchanged              |
| `deleted`      | Item flagged as deleted by the delta API                           |
| *(skipped)*    | No detectable change (path, name, eTag all match)                  |

Only items with a detected change are included in the snapshot. Items with no change are silently skipped, which is why incremental runs complete in seconds when nothing has changed.

## File Processing Pipeline

Atlas uses different strategies depending on file size:

```
File Size               Strategy                          Memory
─────────────────────────────────────────────────────────────────
< 4 MB                  Single Graph API request           < 4 MB
4 MB – 512 MB           In-memory chunked download         up to ~512 MB
≥ 512 MB                Zero-disk streaming pipeline       ~24 MB (constant)
```

### Small Files (< 512 MB)

Files under 512 MB are downloaded in memory (via a single request for files < 4 MB, or chunked range requests for 4 MB -- 512 MB). The download is retried up to 3 times at the file level. After download:

1. SHA-256 hash is computed (in 64 MB chunks to avoid Node.js buffer limits on very large buffers)
2. The hash determines the content-addressed storage key: `onedrive/data/{owner}/{sha256}`
3. If the key already exists in S3, the file is **deduplicated** (no upload)
4. Otherwise, the plaintext is encrypted with AES-256-GCM and uploaded

### Large Files (>= 512 MB) -- Zero-Disk Streaming

For files at or above 512 MB, Atlas uses a zero-disk streaming pipeline that never writes plaintext to disk and maintains a flat ~24 MB memory profile regardless of file size.

**Why not just use the small-file path?** A 6 GB video file would require 6 GB of RAM to hold in a Buffer. This caused OOM kills in early testing. The streaming pipeline solves this by processing data in small chunks and uploading as it goes.

#### Single-Pass Architecture

The pipeline processes the file in a single download pass:

```
OneDrive ──4 MB chunks──► SHA-256 hash ──► AES-256-GCM cipher ──► 8 MB parts ──► S3 staging key
                           (running)        (streaming)            (multipart upload)
```

1. **Download**: 4 MB chunks fetched via HTTP Range requests, each independently retried (5 attempts, exponential backoff)
2. **Hash**: Each plaintext chunk is fed to a running SHA-256 hash
3. **Encrypt**: Each chunk passes through `cipher.update()`, producing ciphertext
4. **Buffer**: Ciphertext accumulates in an 8 MB buffer
5. **Upload**: When the buffer fills, it's uploaded as an S3 multipart part

#### Deferred Part 1 (Auth Tag Problem)

AES-256-GCM produces its authentication tag only after `cipher.final()`. Atlas stores encrypted data in the format `[IV (12 bytes)][auth_tag (16 bytes)][ciphertext]`, meaning the first 28 bytes aren't known until the entire file is processed.

S3 multipart upload allows uploading parts in **any order** -- only `CompleteMultipartUpload` requires ascending part numbers. Atlas exploits this:

- The first ~8 MB of ciphertext is held in memory
- Parts 2..N are uploaded as ciphertext accumulates during the stream
- After the stream completes: `cipher.final()` yields the auth tag, and part 1 is constructed as `[IV][auth_tag][first ~8 MB ciphertext]` and uploaded last
- `CompleteMultipartUpload` assembles `[part1, part2, ..., partN]` in order

This preserves the existing encryption format without changes to decryption or restore.

#### Staging Key + Content-Addressed Dedup

The SHA-256 hash (needed for the content-addressed canonical key) isn't known until all bytes are processed. Atlas solves this with a two-step approach:

1. **Upload to a staging key**: `onedrive/staging/{owner}/{item_id}-{random}`
2. **After all parts are uploaded**: the hash is known, check if `onedrive/data/{owner}/{sha256}` exists
   - **Duplicate**: `AbortMultipartUpload` -- uploaded parts are cleaned up, zero permanent storage cost
   - **Not duplicate**: `CompleteMultipartUpload` → server-side copy to canonical key → delete staging

The server-side copy from staging to canonical is internal to S3 (zero bandwidth through Atlas). Objects <= 5 GB use a single `CopyObjectCommand`; larger objects use multipart `UploadPartCopy`.

#### Memory Budget

| Component              | Size   |
| ---------------------- | ------ |
| Download chunk         | 4 MB   |
| Accumulation buffer    | 8 MB   |
| Held part 1 ciphertext | 8 MB   |
| Overhead               | ~4 MB  |
| **Total peak**         | **~24 MB** |

This is constant regardless of file size -- a 200 GB file uses the same ~24 MB as a 600 MB file.

## Content-Addressed Deduplication

Like Exchange backup, OneDrive uses SHA-256 content addressing. The storage key for every file is `onedrive/data/{owner}/{sha256}`, computed from the **plaintext** content before encryption.

If two files (even across different snapshots) have identical content, they produce the same hash and share a single encrypted blob in S3. This is particularly valuable in large tenants where:

- The same presentation or report is uploaded to multiple users' OneDrives
- A file is renamed or moved (eTag changes, content doesn't) across backup runs
- Previous full backups overlap with incremental runs

For the large-file pipeline, dedup is checked **after** the staging upload completes but **before** the multipart upload is finalised. If the canonical key exists, `AbortMultipartUpload` cleans up the parts at zero permanent cost.

## Storage Layout

OneDrive data lives under the `onedrive/` prefix in the tenant bucket:

```
atlas-{tenant_id}/
└── onedrive/
    ├── data/{owner}/{sha256}                  # encrypted file blobs (content-addressed)
    ├── staging/{owner}/{item_id}-{random}     # ephemeral staging keys (cleaned up)
    ├── manifests/{owner}/{snapshot_id}.json   # encrypted snapshot manifests
    ├── index/{owner}/files/{file_id}.json     # encrypted per-file version timelines
    └── _meta/{owner}/delta.json               # encrypted delta cursor
```

| Prefix                               | Purpose                                        |
| ------------------------------------ | ---------------------------------------------- |
| `onedrive/data/{owner}/`             | Encrypted file content, keyed by SHA-256       |
| `onedrive/staging/{owner}/`          | Temporary staging keys for large file pipeline |
| `onedrive/manifests/{owner}/`        | Snapshot manifests listing all changed files   |
| `onedrive/index/{owner}/files/`      | Per-file version indexes for point-in-time lookup |
| `onedrive/_meta/{owner}/delta.json`  | Delta cursor with per-drive delta links        |

The staging prefix is ephemeral -- objects and incomplete multipart uploads are cleaned up automatically at the start of every backup run.

## Crash Safety

Atlas is designed to leave the system in a recoverable state even after `kill -9`:

### Persist Order

The backup service saves data in a specific order:

```
1. manifest.save()         ← snapshot of what was backed up
2. file_indexes.append()   ← per-file version timeline entries
3. cursor.save()           ← delta link advancement (LAST)
```

**Why cursor-last matters**: If a crash occurs after step 1 but before step 3, the delta link has *not* advanced. The next run re-fetches the same delta, re-discovers the same files, hits the dedup check (canonical keys already exist), and creates a new manifest. Worst case: redundant work, never data loss.

The previous design saved the cursor first, which meant a crash between cursor and manifest would advance the delta past files that were never recorded -- invisible to restore, only recoverable with `--full`.

### Staging Cleanup

On every backup start, `cleanup_stale_staging()` runs before file processing:

1. **Completed staging objects**: Any `onedrive/staging/{owner}/*` keys are deleted
2. **Incomplete multipart uploads**: All in-progress uploads under the staging prefix are aborted

This is fully self-cleaning and does not depend on S3 bucket lifecycle policies. A `kill -9` during the streaming pipeline leaves only encrypted staging data in S3, which is cleaned up on the next run.

### What Gets Orphaned

| Crash point                    | Orphaned data                     | Cleaned up by                  |
| ------------------------------ | --------------------------------- | ------------------------------ |
| During download/upload stream  | Incomplete multipart upload parts | `cleanup_stale_staging()` next run |
| After `CompleteMultipartUpload`, before copy | Completed staging object  | `cleanup_stale_staging()` next run |
| After copy, before staging delete | Completed staging object         | `cleanup_stale_staging()` next run |
| After manifest save, before cursor save | None (data safe, delta re-fetched) | Automatic via dedup |

In all cases, plaintext data exists only as in-flight 4 MB buffers in process memory. A crash cannot leave plaintext on disk.

## Encryption

OneDrive files use the same envelope encryption as Exchange messages:

- **Same DEK**: the tenant's data encryption key encrypts both email and OneDrive data
- **Same algorithm**: AES-256-GCM with a fresh random IV per object
- **Same format**: `[IV (12 bytes)][auth_tag (16 bytes)][ciphertext]`

The large-file streaming pipeline produces ciphertext that is byte-for-byte compatible with the standard decryption path -- the deferred part 1 technique is transparent to consumers.

See the [Security](/security) page for full details on key hierarchy, scrypt parameters, and threat model.

## Differences from Exchange Backup

| Feature                  | Exchange                              | OneDrive                               |
| ------------------------ | ------------------------------------- | -------------------------------------- |
| Data type                | Email messages + attachments          | Files of any type                      |
| Max item size            | Typically < 50 MB                     | Up to hundreds of GB                   |
| Delta API                | Per-folder `messages/delta`           | Per-drive `driveItem/delta`            |
| Delta state              | Saved in manifest                     | Separate encrypted cursor file         |
| Download method          | Graph message content API             | HTTP Range requests (chunked)          |
| Large item handling      | In-memory (messages are small)        | Zero-disk streaming pipeline           |
| Dedup scope              | Per-mailbox content hash              | Per-owner content hash                 |
| Tenant-wide backup       | `atlas backup` (all mailboxes)        | Per-owner only (`-o` required)         |
| Folder structure         | Outlook folder hierarchy              | OneDrive directory tree                |
| Restore                  | Re-creates messages in Exchange       | *(not yet implemented)*                |
| Object Lock support      | Available via `--retention-days`      | Port-ready (wired when feature lands)  |

## Retry Behavior

Transient errors are retried at multiple levels:

| Level              | Retries | Backoff                | Covers                                |
| ------------------ | ------- | ---------------------- | ------------------------------------- |
| Graph API          | 12      | Exponential + jitter, respects `Retry-After` | Delta queries, drive listing          |
| File download      | 3       | Exponential + jitter   | Small/medium files (< 512 MB)         |
| Chunk download     | 5       | Exponential + jitter   | Large file 4 MB chunks                |
| S3 multipart part  | 5       | Exponential + jitter   | Individual part uploads               |
| S3 server-side copy part | 5 | Exponential + jitter   | Multipart copy parts (files > 5 GB)   |

Non-retryable errors (HTTP 403, 404) fail immediately without retry.
