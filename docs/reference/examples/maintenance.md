# Maintenance & Monitoring

Patterns for ongoing integrity verification, storage metrics collection, and snapshot lifecycle management.

::: tip Setup
All examples assume an Atlas instance created with `createAtlasInstance`. See [Programmatic SDK](/reference/sdk) for full configuration options.
:::

## Periodic Integrity Verification

Run `verifySnapshot` on recent snapshots to confirm that data in S3 has not been corrupted or tampered with. This is the programmatic equivalent of `atlas verify`.

```typescript
import type { AtlasInstance } from 'm365-atlas/sdk';

async function verify_recent_backups(atlas: AtlasInstance, mailboxes: string[]) {
  for (const mailbox of mailboxes) {
    const snapshots = await atlas.listSnapshots(mailbox);

    if (snapshots.length === 0) {
      console.log(`[skip] ${mailbox} — no snapshots`);
      continue;
    }

    const latest = snapshots[snapshots.length - 1];
    const result = await atlas.verifySnapshot(latest.snapshot_id);

    if (result.failed.length === 0) {
      console.log(
        `[pass] ${mailbox} — ${result.passed}/${result.total_checked} objects verified`,
      );
    } else {
      console.error(
        `[FAIL] ${mailbox} — ${result.failed.length} integrity failure(s):`,
      );
      for (const failure of result.failed) {
        console.error(`  - ${failure}`);
      }
    }
  }
}
```

Verification downloads every encrypted object, decrypts it (validating the GCM authentication tag), recomputes the plaintext SHA-256, and compares it against the manifest. Any mismatch indicates corruption or tampering.

## Storage Monitoring Dashboard

Pull storage statistics to feed into a monitoring system (Prometheus, Datadog, Grafana, or a custom dashboard).

```typescript
import type { AtlasInstance } from 'm365-atlas/sdk';

async function collect_storage_metrics(atlas: AtlasInstance) {
  const stats = await atlas.getBucketStats();

  const metrics = {
    tenant_id: stats.tenant_id,
    total_mailboxes: stats.mailbox_count,
    total_snapshots: stats.snapshot_count,
    total_messages: stats.total_messages,
    total_size_gb: (stats.total_size_bytes / (1024 ** 3)).toFixed(2),
    total_attachments: stats.attachment_count,
    attachment_size_gb: (stats.attachment_size_bytes / (1024 ** 3)).toFixed(2),
  };

  console.log(JSON.stringify(metrics, null, 2));
  return metrics;
}
```

For per-mailbox breakdowns:

```typescript
async function collect_mailbox_metrics(atlas: AtlasInstance, mailbox: string) {
  const stats = await atlas.getMailboxStats(mailbox);

  return {
    mailbox: stats.mailbox_id,
    snapshots: stats.snapshot_count,
    messages: stats.total_messages,
    size_mb: (stats.total_size_bytes / (1024 ** 2)).toFixed(1),
    attachments: stats.attachment_count,
    folders: stats.folders.map((f) => ({
      id: f.folder_id,
      messages: f.message_count,
      size_mb: (f.total_size_bytes / (1024 ** 2)).toFixed(1),
    })),
  };
}
```

## Snapshot Lifecycle Management

Clean up old snapshots while keeping recent ones. Useful for environments where storage costs matter and you only need the last N snapshots per mailbox.

```typescript
import type { AtlasInstance } from 'm365-atlas/sdk';

async function prune_old_snapshots(
  atlas: AtlasInstance,
  mailbox: string,
  keep_count: number,
) {
  const snapshots = await atlas.listSnapshots(mailbox);

  if (snapshots.length <= keep_count) {
    console.log(`[skip] ${mailbox} — ${snapshots.length} snapshot(s), nothing to prune`);
    return;
  }

  const to_delete = snapshots.slice(0, snapshots.length - keep_count);

  for (const snapshot of to_delete) {
    const result = await atlas.deleteSnapshot(snapshot.snapshot_id);
    console.log(
      `[prune] ${mailbox} — deleted snapshot ${snapshot.snapshot_id} ` +
      `(${result.deleted_count} objects removed)`,
    );
  }

  console.log(
    `[done] ${mailbox} — pruned ${to_delete.length} snapshot(s), kept ${keep_count}`,
  );
}
```

::: tip Snapshot Deletion vs. Data Deletion
`deleteSnapshot` removes only the manifest file. The underlying data objects are retained because they may be referenced by other snapshots (content-addressed deduplication). To remove all data for a mailbox, use `deleteMailboxData`.
:::
