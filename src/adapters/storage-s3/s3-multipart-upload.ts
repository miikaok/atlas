import { createHash } from 'node:crypto';
import {
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import type { StorageObjectLockPolicy } from '@/ports/storage/object-storage.port';
import { logger } from '@/utils/logger';

export const MULTIPART_THRESHOLD = 64 * 1024 * 1024;
const PART_SIZE = 8 * 1024 * 1024;
const MAX_PART_RETRIES = 5;
const PART_BASE_DELAY_MS = 1_000;
const PART_MAX_DELAY_MS = 30_000;

interface CompletedPart {
  ETag: string;
  PartNumber: number;
}

/** Uploads a large buffer via S3 multipart upload with per-part retry. */
export async function put_multipart(
  client: S3Client,
  bucket: string,
  key: string,
  data: Buffer,
  metadata?: Record<string, string>,
  object_lock_policy?: StorageObjectLockPolicy,
): Promise<void> {
  const { UploadId: upload_id } = await client.send(
    new CreateMultipartUploadCommand({
      Bucket: bucket,
      Key: key,
      Metadata: metadata,
      ObjectLockMode: object_lock_policy?.mode,
      ObjectLockRetainUntilDate: object_lock_policy?.retain_until
        ? new Date(object_lock_policy.retain_until)
        : undefined,
    }),
  );

  if (!upload_id) throw new Error(`S3 CreateMultipartUpload returned no UploadId for ${key}`);

  try {
    const completed_parts = await upload_all_parts(client, bucket, key, upload_id, data);
    await client.send(
      new CompleteMultipartUploadCommand({
        Bucket: bucket,
        Key: key,
        UploadId: upload_id,
        MultipartUpload: { Parts: completed_parts },
      }),
    );
  } catch (err) {
    await abort_upload(client, bucket, key, upload_id);
    throw err;
  }
}

async function upload_all_parts(
  client: S3Client,
  bucket: string,
  key: string,
  upload_id: string,
  data: Buffer,
): Promise<CompletedPart[]> {
  const part_count = Math.ceil(data.length / PART_SIZE);
  const parts: CompletedPart[] = [];

  for (let i = 0; i < part_count; i++) {
    const start = i * PART_SIZE;
    const end = Math.min(start + PART_SIZE, data.length);
    const part_data = data.subarray(start, end);
    const part_number = i + 1;

    const etag = await upload_part_with_retry(
      client,
      bucket,
      key,
      upload_id,
      part_number,
      part_data,
      part_count,
    );
    parts.push({ ETag: etag, PartNumber: part_number });
  }

  return parts;
}

async function upload_part_with_retry(
  client: S3Client,
  bucket: string,
  key: string,
  upload_id: string,
  part_number: number,
  part_data: Buffer,
  total_parts: number,
): Promise<string> {
  for (let attempt = 0; attempt <= MAX_PART_RETRIES; attempt++) {
    try {
      const content_md5 = createHash('md5').update(part_data).digest('base64');
      const result = await client.send(
        new UploadPartCommand({
          Bucket: bucket,
          Key: key,
          UploadId: upload_id,
          PartNumber: part_number,
          Body: part_data,
          ContentMD5: content_md5,
        }),
      );

      if (!result.ETag) throw new Error(`UploadPart ${part_number} returned no ETag`);
      return result.ETag;
    } catch (err) {
      if (attempt === MAX_PART_RETRIES) {
        throw new Error(
          `S3 multipart part ${part_number}/${total_parts} failed after ${attempt + 1} attempts: ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
      }

      const delay = compute_part_retry_delay(attempt);
      logger.debug(
        `S3 part ${part_number}/${total_parts} retry ${attempt + 1}/${MAX_PART_RETRIES} ` +
          `in ${(delay / 1000).toFixed(1)}s`,
      );
      await sleep(delay);
    }
  }

  throw new Error('upload_part_with_retry: unreachable');
}

async function abort_upload(
  client: S3Client,
  bucket: string,
  key: string,
  upload_id: string,
): Promise<void> {
  try {
    await client.send(
      new AbortMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: upload_id }),
    );
  } catch (abort_err) {
    logger.warn(
      `Failed to abort multipart upload ${upload_id}: ` +
        `${abort_err instanceof Error ? abort_err.message : String(abort_err)}`,
    );
  }
}

function compute_part_retry_delay(attempt: number): number {
  const base = PART_BASE_DELAY_MS * 2 ** attempt;
  const jitter = Math.random() * PART_BASE_DELAY_MS;
  return Math.min(base + jitter, PART_MAX_DELAY_MS);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
