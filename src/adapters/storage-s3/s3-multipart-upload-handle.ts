import { createHash } from 'node:crypto';
import {
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import type { MultipartUploadHandle } from '@/ports/storage/object-storage.port';
import { logger } from '@/utils/logger';

const MAX_PART_RETRIES = 5;
const PART_BASE_DELAY_MS = 1_000;
const PART_MAX_DELAY_MS = 30_000;

/** S3-backed handle for part-level multipart upload control. */
export class S3MultipartUploadHandle implements MultipartUploadHandle {
  constructor(
    private readonly _client: S3Client,
    private readonly _bucket: string,
    private readonly _key: string,
    private readonly _upload_id: string,
  ) {}

  /** Uploads a single part with per-part retry and Content-MD5 integrity. */
  async upload_part(part_number: number, data: Buffer): Promise<string> {
    for (let attempt = 0; attempt <= MAX_PART_RETRIES; attempt++) {
      try {
        const content_md5 = createHash('md5').update(data).digest('base64');
        const result = await this._client.send(
          new UploadPartCommand({
            Bucket: this._bucket,
            Key: this._key,
            UploadId: this._upload_id,
            PartNumber: part_number,
            Body: data,
            ContentMD5: content_md5,
          }),
        );

        if (!result.ETag) throw new Error(`UploadPart ${part_number} returned no ETag`);
        return result.ETag;
      } catch (err) {
        if (attempt === MAX_PART_RETRIES) {
          throw new Error(
            `Multipart part ${part_number} failed after ${attempt + 1} attempts: ` +
              `${err instanceof Error ? err.message : String(err)}`,
          );
        }

        const delay = compute_delay(attempt);
        logger.debug(
          `Multipart part ${part_number} retry ${attempt + 1}/${MAX_PART_RETRIES} ` +
            `in ${(delay / 1000).toFixed(1)}s`,
        );
        await sleep(delay);
      }
    }

    throw new Error('upload_part: unreachable');
  }

  async complete(parts: Array<{ ETag: string; PartNumber: number }>): Promise<void> {
    await this._client.send(
      new CompleteMultipartUploadCommand({
        Bucket: this._bucket,
        Key: this._key,
        UploadId: this._upload_id,
        MultipartUpload: { Parts: parts },
      }),
    );
  }

  async abort(): Promise<void> {
    try {
      await this._client.send(
        new AbortMultipartUploadCommand({
          Bucket: this._bucket,
          Key: this._key,
          UploadId: this._upload_id,
        }),
      );
    } catch (err) {
      logger.warn(
        `Failed to abort multipart upload ${this._upload_id}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

function compute_delay(attempt: number): number {
  const base = PART_BASE_DELAY_MS * 2 ** attempt;
  const jitter = Math.random() * PART_BASE_DELAY_MS;
  return Math.min(base + jitter, PART_MAX_DELAY_MS);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
