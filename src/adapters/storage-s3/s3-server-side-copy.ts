import {
  CopyObjectCommand,
  HeadObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCopyCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import type { StorageObjectLockPolicy } from '@/ports/storage/object-storage.port';
import { logger } from '@/utils/logger';

const MAX_SINGLE_COPY_BYTES = 5 * 1024 * 1024 * 1024;
const COPY_PART_SIZE = 5 * 1024 * 1024 * 1024;
const MAX_COPY_PART_RETRIES = 5;
const COPY_RETRY_BASE_MS = 1_000;
const COPY_RETRY_MAX_MS = 30_000;

/** Server-side copy within a single bucket. Routes to single or multipart copy by object size. */
export async function copy_object(
  client: S3Client,
  bucket: string,
  source_key: string,
  dest_key: string,
  metadata?: Record<string, string>,
  object_lock_policy?: StorageObjectLockPolicy,
): Promise<void> {
  const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: source_key }));
  const size = head.ContentLength ?? 0;

  if (size <= MAX_SINGLE_COPY_BYTES) {
    await single_copy(client, bucket, source_key, dest_key, metadata, object_lock_policy);
  } else {
    await multipart_copy(client, bucket, source_key, dest_key, size, metadata, object_lock_policy);
  }
}

async function single_copy(
  client: S3Client,
  bucket: string,
  source_key: string,
  dest_key: string,
  metadata?: Record<string, string>,
  object_lock_policy?: StorageObjectLockPolicy,
): Promise<void> {
  await client.send(
    new CopyObjectCommand({
      Bucket: bucket,
      Key: dest_key,
      CopySource: `${bucket}/${source_key}`,
      Metadata: metadata,
      MetadataDirective: metadata ? 'REPLACE' : 'COPY',
      ObjectLockMode: object_lock_policy?.mode,
      ObjectLockRetainUntilDate: object_lock_policy?.retain_until
        ? new Date(object_lock_policy.retain_until)
        : undefined,
    }),
  );
}

async function multipart_copy(
  client: S3Client,
  bucket: string,
  source_key: string,
  dest_key: string,
  source_size: number,
  metadata?: Record<string, string>,
  object_lock_policy?: StorageObjectLockPolicy,
): Promise<void> {
  const { UploadId: upload_id } = await client.send(
    new CreateMultipartUploadCommand({
      Bucket: bucket,
      Key: dest_key,
      Metadata: metadata,
      ObjectLockMode: object_lock_policy?.mode,
      ObjectLockRetainUntilDate: object_lock_policy?.retain_until
        ? new Date(object_lock_policy.retain_until)
        : undefined,
    }),
  );

  if (!upload_id) throw new Error(`CreateMultipartUpload for copy returned no UploadId`);

  try {
    const part_count = Math.ceil(source_size / COPY_PART_SIZE);
    const completed: Array<{ ETag: string; PartNumber: number }> = [];

    for (let i = 0; i < part_count; i++) {
      const start = i * COPY_PART_SIZE;
      const end = Math.min(start + COPY_PART_SIZE, source_size) - 1;
      const part_number = i + 1;

      const etag = await copy_part_with_retry(
        client,
        bucket,
        source_key,
        dest_key,
        upload_id,
        part_number,
        start,
        end,
        part_count,
      );
      completed.push({ ETag: etag, PartNumber: part_number });
    }

    await client.send(
      new CompleteMultipartUploadCommand({
        Bucket: bucket,
        Key: dest_key,
        UploadId: upload_id,
        MultipartUpload: { Parts: completed },
      }),
    );
  } catch (err) {
    await abort_copy_safe(client, bucket, dest_key, upload_id);
    throw err;
  }
}

async function copy_part_with_retry(
  client: S3Client,
  bucket: string,
  source_key: string,
  dest_key: string,
  upload_id: string,
  part_number: number,
  start: number,
  end: number,
  total_parts: number,
): Promise<string> {
  for (let attempt = 0; attempt <= MAX_COPY_PART_RETRIES; attempt++) {
    try {
      const result = await client.send(
        new UploadPartCopyCommand({
          Bucket: bucket,
          Key: dest_key,
          UploadId: upload_id,
          PartNumber: part_number,
          CopySource: `${bucket}/${source_key}`,
          CopySourceRange: `bytes=${start}-${end}`,
        }),
      );

      const etag = result.CopyPartResult?.ETag;
      if (!etag) throw new Error(`UploadPartCopy ${part_number} returned no ETag`);
      return etag;
    } catch (err) {
      if (attempt === MAX_COPY_PART_RETRIES) {
        throw new Error(
          `Copy part ${part_number}/${total_parts} failed after ${attempt + 1} attempts: ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
      }

      const delay = compute_delay(attempt);
      logger.debug(
        `Copy part ${part_number}/${total_parts} retry ${attempt + 1}/${MAX_COPY_PART_RETRIES} ` +
          `in ${(delay / 1000).toFixed(1)}s`,
      );
      await sleep(delay);
    }
  }

  throw new Error('copy_part_with_retry: unreachable');
}

async function abort_copy_safe(
  client: S3Client,
  bucket: string,
  key: string,
  upload_id: string,
): Promise<void> {
  try {
    await client.send(
      new AbortMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: upload_id }),
    );
  } catch (err) {
    logger.warn(
      `Failed to abort copy multipart ${upload_id}: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function compute_delay(attempt: number): number {
  const base = COPY_RETRY_BASE_MS * 2 ** attempt;
  const jitter = Math.random() * COPY_RETRY_BASE_MS;
  return Math.min(base + jitter, COPY_RETRY_MAX_MS);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
