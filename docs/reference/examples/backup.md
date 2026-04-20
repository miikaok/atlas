# Backup Patterns

Production-ready patterns for integrating Atlas backup operations into your Node.js applications. All examples use real return types from the SDK.

::: tip Setup
All examples assume an Atlas instance created with `createAtlasInstance`. See [Programmatic SDK](/reference/sdk) for full configuration options.
:::

## Conditional Backup: Check Status First

The most common pattern. Check which mailboxes actually have pending changes before running expensive backup operations. This avoids unnecessary Graph API calls and reduces bandwidth during scheduled runs.

```typescript
import { createAtlasInstance } from 'm365-atlas/sdk';

const atlas = createAtlasInstance({
  tenantId: process.env.ATLAS_TENANT_ID!,
  clientId: process.env.ATLAS_CLIENT_ID!,
  clientSecret: process.env.ATLAS_CLIENT_SECRET!,
  s3Endpoint: process.env.ATLAS_S3_ENDPOINT!,
  s3AccessKey: process.env.ATLAS_S3_ACCESS_KEY!,
  s3SecretKey: process.env.ATLAS_S3_SECRET_KEY!,
  encryptionPassphrase: process.env.ATLAS_ENCRYPTION_PASSPHRASE!,
});

const mailboxes = [
  'ceo@company.com',
  'finance@company.com',
  'legal@company.com',
];

for (const mailbox of mailboxes) {
  const status = await atlas.checkMailboxStatus(mailbox);

  if (status.is_up_to_date) {
    console.log(`[skip] ${mailbox} — no changes since last backup`);
    continue;
  }

  console.log(
    `[backup] ${mailbox} — ${status.total_pending_changes} pending change(s) across ${status.total_folders} folder(s)`,
  );

  const result = await atlas.backupMailbox(mailbox);

  console.log(
    `[done] ${mailbox} — snapshot ${result.snapshot.id}, ` +
    `${result.summary.stored} stored, ${result.summary.deduplicated} deduped, ` +
    `${result.summary.attachments_stored} attachments (${result.summary.elapsed_ms}ms)`,
  );
}
```

`checkMailboxStatus` is a lightweight delta peek -- it queries Graph without consuming the delta token, so the subsequent `backupMailbox` call still picks up from the correct sync point.

## Nightly Backup Job with Error Handling

A robust scheduled job that backs up all mailboxes, collects results, and exits with an appropriate code for your process manager (cron, systemd, orchestration platform).

```typescript
import { createAtlasInstance } from 'm365-atlas/sdk';
import type { AtlasInstance } from 'm365-atlas/sdk';

interface BackupReport {
  mailbox: string;
  snapshot_id: string;
  stored: number;
  deduplicated: number;
  attachments: number;
  elapsed_ms: number;
}

async function run_nightly_backup(atlas: AtlasInstance, mailboxes: string[]) {
  const succeeded: BackupReport[] = [];
  const failed: { mailbox: string; error: string }[] = [];

  for (const mailbox of mailboxes) {
    try {
      const status = await atlas.checkMailboxStatus(mailbox);

      if (status.is_up_to_date) {
        console.log(`[skip] ${mailbox} — already current`);
        continue;
      }

      const result = await atlas.backupMailbox(mailbox);

      succeeded.push({
        mailbox,
        snapshot_id: result.snapshot.id,
        stored: result.summary.stored,
        deduplicated: result.summary.deduplicated,
        attachments: result.summary.attachments_stored,
        elapsed_ms: result.summary.elapsed_ms,
      });

      if (result.summary.interrupted) {
        console.warn(
          `[warn] ${mailbox} — backup was interrupted, ` +
          `${result.summary.completed_folder_count}/${result.summary.total_folder_count} folders completed`,
        );
      }

      if (result.summary.folder_errors.length > 0) {
        console.warn(
          `[warn] ${mailbox} — ${result.summary.folder_errors.length} folder error(s): ` +
          result.summary.folder_errors.join(', '),
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failed.push({ mailbox, error: message });
      console.error(`[fail] ${mailbox} — ${message}`);
    }
  }

  console.log(`\nBackup complete: ${succeeded.length} succeeded, ${failed.length} failed`);

  return { succeeded, failed };
}

// --- entry point ---

const atlas = createAtlasInstance({
  tenantId: process.env.ATLAS_TENANT_ID!,
  clientId: process.env.ATLAS_CLIENT_ID!,
  clientSecret: process.env.ATLAS_CLIENT_SECRET!,
  s3Endpoint: process.env.ATLAS_S3_ENDPOINT!,
  s3AccessKey: process.env.ATLAS_S3_ACCESS_KEY!,
  s3SecretKey: process.env.ATLAS_S3_SECRET_KEY!,
  encryptionPassphrase: process.env.ATLAS_ENCRYPTION_PASSPHRASE!,
});

const mailboxes = [
  'alice@company.com',
  'bob@company.com',
  'carol@company.com',
];

const { failed } = await run_nightly_backup(atlas, mailboxes);
process.exit(failed.length > 0 ? 1 : 0);
```

The non-zero exit code on failure integrates with cron (which can send alert emails on failure), systemd (which logs `FailureAction`), and CI/CD pipelines.

## Backup, Replicate, and Report

Back up each mailbox, immediately replicate the snapshot to an offsite target, and collect the results. This is the core loop for a 3-2-1 strategy -- adapt the reporting to whatever fits your stack (webhook, database row, structured log, email).

```typescript
import { createAtlasInstance, createStorageTarget } from 'm365-atlas/sdk';

const atlas = createAtlasInstance({
  tenantId: process.env.ATLAS_TENANT_ID!,
  clientId: process.env.ATLAS_CLIENT_ID!,
  clientSecret: process.env.ATLAS_CLIENT_SECRET!,
  s3Endpoint: process.env.ATLAS_S3_ENDPOINT!,
  s3AccessKey: process.env.ATLAS_S3_ACCESS_KEY!,
  s3SecretKey: process.env.ATLAS_S3_SECRET_KEY!,
  encryptionPassphrase: process.env.ATLAS_ENCRYPTION_PASSPHRASE!,
});

const offsite = createStorageTarget({
  s3Endpoint: process.env.OFFSITE_S3_ENDPOINT!,
  s3AccessKey: process.env.OFFSITE_S3_ACCESS_KEY!,
  s3SecretKey: process.env.OFFSITE_S3_SECRET_KEY!,
  encryptionPassphrase: process.env.ATLAS_ENCRYPTION_PASSPHRASE!,
});

const mailboxes = ['ceo@company.com', 'finance@company.com', 'legal@company.com'];
const results = [];
const replications: Promise<unknown>[] = [];

for (const mailbox of mailboxes) {
  try {
    const backup = await atlas.backupMailbox(mailbox);

    // Replication is S3-to-S3 only (no Graph API calls), so fire it off
    // concurrently while the next mailbox backup runs.
    replications.push(atlas.replicateSnapshot(backup.snapshot.id, [offsite]));

    results.push({ mailbox, snapshot_id: backup.snapshot.id, stored: backup.summary.stored, ok: true });
  } catch (err) {
    results.push({ mailbox, ok: false, error: (err as Error).message });
  }
}

await Promise.allSettled(replications);

// results is a plain array -- send it wherever you want
console.log(JSON.stringify(results, null, 2));
process.exit(results.some((r) => !r.ok) ? 1 : 0);
```

Backups run sequentially to avoid Graph API throttling, but each replication fires off immediately without blocking the next backup. Replication is pure S3-to-S3 traffic (typically LAN or inter-datacenter fiber), so it runs concurrently in the background. `Promise.allSettled` at the end ensures all replications finish before the process exits. If the job crashes partway, the next run picks up naturally -- `backupMailbox` produces a delta snapshot and `replicateSnapshot` skips objects already on the target.

## Multi-Tenant Management

For managed service providers backing up multiple tenants, create separate Atlas instances per tenant. Each instance is cryptographically isolated -- different KEK, different DEK, different S3 bucket.

```typescript
interface TenantConfig {
  name: string;
  tenantId: string;
  clientId: string;
  clientSecret: string;
  mailboxes: string[];
}

async function backup_all_tenants(
  tenants: TenantConfig[],
  shared_s3: { endpoint: string; accessKey: string; secretKey: string },
  passphrase: string,
) {
  for (const tenant of tenants) {
    console.log(`\n--- Tenant: ${tenant.name} (${tenant.tenantId}) ---`);

    const atlas = createAtlasInstance({
      tenantId: tenant.tenantId,
      clientId: tenant.clientId,
      clientSecret: tenant.clientSecret,
      s3Endpoint: shared_s3.endpoint,
      s3AccessKey: shared_s3.accessKey,
      s3SecretKey: shared_s3.secretKey,
      encryptionPassphrase: passphrase,
    });

    for (const mailbox of tenant.mailboxes) {
      try {
        const result = await atlas.backupMailbox(mailbox);
        console.log(`  [done] ${mailbox} — ${result.summary.stored} stored`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`  [fail] ${mailbox} — ${message}`);
      }
    }
  }
}
```

::: warning Sequential Processing Is Required
Process tenants and mailboxes **sequentially**, not with `Promise.all`. Each backup makes hundreds or thousands of Microsoft Graph API calls. Parallel execution would trigger aggressive HTTP 429 throttling with exponential backoff, making the total runtime longer, not shorter.
:::
