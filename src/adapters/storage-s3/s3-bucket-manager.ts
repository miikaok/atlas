import {
  CreateBucketCommand,
  HeadBucketCommand,
  type S3Client,
} from '@aws-sdk/client-s3';

const _checked_buckets = new Set<string>();

/**
 * Ensures a bucket exists, creating it if necessary.
 * Caches results in-process so subsequent calls for the same bucket are free.
 */
export async function ensure_bucket_exists(client: S3Client, bucket: string): Promise<void> {
  if (_checked_buckets.has(bucket)) return;

  const exists = await bucket_exists(client, bucket);
  if (!exists) {
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
  }

  _checked_buckets.add(bucket);
}

/** Probes whether a bucket already exists and is accessible. */
async function bucket_exists(client: S3Client, bucket: string): Promise<boolean> {
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
    return true;
  } catch (err) {
    const code = (err as { name?: string }).name;
    if (code === 'NotFound' || code === 'NoSuchBucket') return false;
    throw err;
  }
}

/** Clears the in-process bucket cache (useful for testing). */
export function reset_bucket_cache(): void {
  _checked_buckets.clear();
}
