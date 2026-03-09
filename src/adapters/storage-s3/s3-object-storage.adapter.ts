import { createHash } from 'node:crypto';
import {
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  type S3Client,
} from '@aws-sdk/client-s3';
import type { ObjectStorage } from '@/ports/storage/object-storage.port';

/**
 * S3-backed ObjectStorage scoped to a single bucket.
 * Not injectable -- created by TenantContextFactory per tenant.
 */
export class S3ObjectStorage implements ObjectStorage {
  constructor(
    private readonly _client: S3Client,
    private readonly _bucket: string,
  ) {}

  /** Uploads data with a Content-MD5 header for transport integrity verification. */
  async put(key: string, data: Buffer, metadata?: Record<string, string>): Promise<void> {
    const content_md5 = createHash('md5').update(data).digest('base64');

    await this._client.send(
      new PutObjectCommand({
        Bucket: this._bucket,
        Key: key,
        Body: data,
        ContentMD5: content_md5,
        Metadata: metadata,
      }),
    );
  }

  /** Downloads the full object and returns it as a Buffer. */
  async get(key: string): Promise<Buffer> {
    const response = await this._client.send(
      new GetObjectCommand({ Bucket: this._bucket, Key: key }),
    );

    const stream = response.Body;
    if (!stream) throw new Error(`Empty response body for key ${key}`);

    return Buffer.from(await stream.transformToByteArray());
  }

  /** Removes a single object. */
  async delete(key: string): Promise<void> {
    await this._client.send(new DeleteObjectCommand({ Bucket: this._bucket, Key: key }));
  }

  /** Returns true if the object exists (HEAD request). */
  async exists(key: string): Promise<boolean> {
    try {
      await this._client.send(new HeadObjectCommand({ Bucket: this._bucket, Key: key }));
      return true;
    } catch (err) {
      const code = (err as { name?: string }).name;
      if (code === 'NotFound' || code === 'NoSuchKey') return false;
      throw err;
    }
  }

  /** Lists all keys sharing the given prefix. */
  async list(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let continuation_token: string | undefined;

    do {
      const response = await this._client.send(
        new ListObjectsV2Command({
          Bucket: this._bucket,
          Prefix: prefix,
          ContinuationToken: continuation_token,
        }),
      );

      for (const obj of response.Contents ?? []) {
        if (obj.Key) keys.push(obj.Key);
      }
      continuation_token = response.NextContinuationToken;
    } while (continuation_token);

    return keys;
  }
}
