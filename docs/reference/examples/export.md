# Export & Compliance

Patterns for exporting backed-up email as portable `.eml` archives and validating storage configuration before committing to immutable backups.

::: tip Setup
All examples assume an Atlas instance created with `createAtlasInstance`. See [Programmatic SDK](/reference/sdk) for full configuration options.
:::

## Automated EML Export for Compliance

Export mailbox backups as `.eml` archives on a schedule -- useful for legal holds, compliance audits, or providing portable copies to departing employees.

```typescript
import type { AtlasInstance } from 'm365-atlas/sdk';

async function export_mailbox_archive(
  atlas: AtlasInstance,
  mailbox: string,
  output_dir: string,
) {
  const timestamp = new Date().toISOString().slice(0, 10);
  const output_path = `${output_dir}/${mailbox.replace('@', '_at_')}_${timestamp}.zip`;

  const result = await atlas.saveMailbox(mailbox, {
    output_path,
    skip_integrity_check: false,
  });

  console.log(
    `[export] ${mailbox} — ${result.saved_count} messages, ` +
    `${result.attachment_count} attachments, ` +
    `${(result.total_bytes / (1024 ** 2)).toFixed(1)} MB → ${result.output_path}`,
  );

  if (result.integrity_failures.length > 0) {
    console.warn(
      `[warn] ${result.integrity_failures.length} integrity failure(s) during export`,
    );
  }

  return result;
}
```

The output zip mirrors the Outlook folder hierarchy with RFC 5322 `.eml` files. Each message includes all backed-up attachments embedded as MIME parts. Filenames use `YYYY-MM-DD_HHmmss_Sanitized-subject.eml` format for chronological sorting.

## Pre-Flight Storage Validation

Before running your first immutable backup, verify that the S3 bucket is correctly configured. This catches misconfiguration before any data is written.

```typescript
import type { AtlasInstance } from 'm365-atlas/sdk';

async function validate_immutable_readiness(atlas: AtlasInstance) {
  const check = await atlas.checkStorage({
    mode: 'GOVERNANCE',
    retention_days: 30,
  });

  console.log('Storage check results:');
  console.log(`  Bucket exists:    ${check.bucket_exists}`);
  console.log(`  Versioning:       ${check.versioning_enabled}`);
  console.log(`  Object Lock:      ${check.object_lock_enabled}`);

  if (!check.bucket_exists || !check.versioning_enabled || !check.object_lock_enabled) {
    throw new Error(
      'Storage is not ready for immutable backups. ' +
      'Ensure the bucket exists with versioning and Object Lock enabled.',
    );
  }

  console.log('Storage is ready for immutable backups.');
}
```

Object Lock must be enabled at bucket creation time -- it cannot be added to an existing bucket. If `object_lock_enabled` is `false`, you need to create a new bucket with Object Lock enabled and update your Atlas configuration. See [Immutability & Object Lock](/operations/immutability) for full setup instructions.
