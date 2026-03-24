import { createHash } from 'node:crypto';
import {
  S3ServiceException,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  ListObjectVersionsCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  CreateMultipartUploadCommand,
  ListMultipartUploadsCommand,
  AbortMultipartUploadCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import type {
  ObjectStorage,
  MultipartUploadHandle,
  StorageImmutabilityProbeRequest,
  StorageImmutabilityProbeResult,
  StorageObjectLockPolicy,
} from '@/ports/storage/object-storage.port';
import { probe_bucket_immutability } from '@/adapters/storage-s3/s3-bucket-manager';
import {
  ObjectLockModeRejectedError,
  ObjectLockUnsupportedError,
  ObjectLockVersioningDisabledError,
} from '@/adapters/storage-s3/object-lock.errors';
import { MULTIPART_THRESHOLD, put_multipart } from '@/adapters/storage-s3/s3-multipart-upload';
import { S3MultipartUploadHandle } from '@/adapters/storage-s3/s3-multipart-upload-handle';
import { copy_object } from '@/adapters/storage-s3/s3-server-side-copy';
import { logger } from '@/utils/logger';

/**
 * S3-backed ObjectStorage scoped to a single bucket.
 * Not injectable -- created by TenantContextFactory per tenant.
 */
export class S3ObjectStorage implements ObjectStorage {
  constructor(
    private readonly _client: S3Client,
    private readonly _bucket: string,
  ) {}

  /** Uploads data, routing through multipart for large payloads. */
  async put(
    key: string,
    data: Buffer,
    metadata?: Record<string, string>,
    object_lock_policy?: StorageObjectLockPolicy,
  ): Promise<void> {
    await this.validate_immutability_policy(object_lock_policy);

    if (data.length > MULTIPART_THRESHOLD) {
      await put_multipart(this._client, this._bucket, key, data, metadata, object_lock_policy);
      return;
    }

    const content_md5 = createHash('md5').update(data).digest('base64');
    try {
      await this._client.send(
        new PutObjectCommand({
          Bucket: this._bucket,
          Key: key,
          Body: data,
          ContentMD5: content_md5,
          Metadata: metadata,
          ObjectLockMode: object_lock_policy?.mode,
          ObjectLockRetainUntilDate: object_lock_policy?.retain_until
            ? new Date(object_lock_policy.retain_until)
            : undefined,
        }),
      );
    } catch (err) {
      if (is_backend_mode_rejection(err, object_lock_policy?.mode)) {
        throw new ObjectLockModeRejectedError(
          this._bucket,
          object_lock_policy?.mode ?? 'UNKNOWN',
          err,
        );
      }
      throw err;
    }
  }

  /** Probes bucket-level immutability readiness. */
  async probe_immutability(
    request: StorageImmutabilityProbeRequest = {},
  ): Promise<StorageImmutabilityProbeResult> {
    return probe_bucket_immutability(this._client, this._bucket, request);
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

  /** Removes a specific object version (or delete marker) by version id. */
  async delete_version(key: string, version_id: string): Promise<void> {
    await this._client.send(
      new DeleteObjectCommand({ Bucket: this._bucket, Key: key, VersionId: version_id }),
    );
  }

  /** Returns true if the object exists (HEAD request). */
  async exists(key: string): Promise<boolean> {
    try {
      await this._client.send(new HeadObjectCommand({ Bucket: this._bucket, Key: key }));
      return true;
    } catch (err) {
      if (is_not_found_error(err)) return false;
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

  /** Lists all object versions and delete markers under a prefix. */
  async list_versions(
    prefix: string,
  ): Promise<{ key: string; version_id: string; is_delete_marker: boolean }[]> {
    const versions: { key: string; version_id: string; is_delete_marker: boolean }[] = [];
    let key_marker: string | undefined;
    let version_id_marker: string | undefined;

    do {
      const response = await this._client.send(
        new ListObjectVersionsCommand({
          Bucket: this._bucket,
          Prefix: prefix,
          KeyMarker: key_marker,
          VersionIdMarker: version_id_marker,
        }),
      );

      for (const version of response.Versions ?? []) {
        if (version.Key && version.VersionId) {
          versions.push({
            key: version.Key,
            version_id: version.VersionId,
            is_delete_marker: false,
          });
        }
      }

      for (const marker of response.DeleteMarkers ?? []) {
        if (marker.Key && marker.VersionId) {
          versions.push({
            key: marker.Key,
            version_id: marker.VersionId,
            is_delete_marker: true,
          });
        }
      }

      key_marker = response.NextKeyMarker;
      version_id_marker = response.NextVersionIdMarker;
      if (!response.IsTruncated) break;
    } while (true);

    return versions;
  }

  /** Starts a multipart upload, returning a handle for part-level control. */
  async begin_multipart_upload(
    key: string,
    metadata?: Record<string, string>,
    object_lock_policy?: StorageObjectLockPolicy,
  ): Promise<MultipartUploadHandle> {
    const { UploadId } = await this._client.send(
      new CreateMultipartUploadCommand({
        Bucket: this._bucket,
        Key: key,
        Metadata: metadata,
        ObjectLockMode: object_lock_policy?.mode,
        ObjectLockRetainUntilDate: object_lock_policy?.retain_until
          ? new Date(object_lock_policy.retain_until)
          : undefined,
      }),
    );

    if (!UploadId) throw new Error(`CreateMultipartUpload returned no UploadId for ${key}`);
    return new S3MultipartUploadHandle(this._client, this._bucket, key, UploadId);
  }

  /** Server-side copy from source to destination within the same bucket. */
  async copy(
    source_key: string,
    dest_key: string,
    metadata?: Record<string, string>,
    object_lock_policy?: StorageObjectLockPolicy,
  ): Promise<void> {
    await copy_object(
      this._client,
      this._bucket,
      source_key,
      dest_key,
      metadata,
      object_lock_policy,
    );
  }

  /** Aborts all incomplete multipart uploads under the given prefix. */
  async abort_incomplete_uploads(prefix: string): Promise<number> {
    let aborted = 0;
    let key_marker: string | undefined;
    let upload_id_marker: string | undefined;

    do {
      const response = await this._client.send(
        new ListMultipartUploadsCommand({
          Bucket: this._bucket,
          Prefix: prefix,
          KeyMarker: key_marker,
          UploadIdMarker: upload_id_marker,
        }),
      );

      for (const upload of response.Uploads ?? []) {
        if (!upload.Key || !upload.UploadId) continue;
        try {
          await this._client.send(
            new AbortMultipartUploadCommand({
              Bucket: this._bucket,
              Key: upload.Key,
              UploadId: upload.UploadId,
            }),
          );
          aborted++;
        } catch (err) {
          logger.warn(
            `Failed to abort stale upload ${upload.UploadId}: ` +
              `${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      key_marker = response.NextKeyMarker;
      upload_id_marker = response.NextUploadIdMarker;
      if (!response.IsTruncated) break;
    } while (true);

    return aborted;
  }

  private async validate_immutability_policy(policy?: StorageObjectLockPolicy): Promise<void> {
    if (!policy || !policy.retain_until) return;
    const probe = await this.probe_immutability({
      mode: policy.mode,
    });
    if (!probe.versioning_enabled) throw new ObjectLockVersioningDisabledError(this._bucket);
    if (!probe.object_lock_enabled) throw new ObjectLockUnsupportedError(this._bucket);
    if (!probe.mode_supported)
      throw new ObjectLockModeRejectedError(this._bucket, policy.mode ?? 'UNKNOWN');
  }
}

function is_backend_mode_rejection(err: unknown, mode?: string): boolean {
  if (!mode) return false;
  if (!(err instanceof S3ServiceException)) return false;
  const error_text = `${err.name} ${err.message}`.toLowerCase();
  return (
    error_text.includes('object lock') ||
    error_text.includes('invalidrequest') ||
    error_text.includes('invalidargument')
  );
}

function is_not_found_error(err: unknown): boolean {
  if (!(err && typeof err === 'object')) return false;

  const typed_error = err as {
    name?: string;
    $metadata?: { httpStatusCode?: number };
  };
  const code = typed_error.name;
  const status = typed_error.$metadata?.httpStatusCode;

  if (code === 'NotFound' || code === 'NoSuchKey') return true;
  return code === 'UnknownError' && status === 404;
}
