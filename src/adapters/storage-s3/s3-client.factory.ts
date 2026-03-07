import { S3Client } from '@aws-sdk/client-s3';
import type { AtlasConfig } from '@/utils/config';

export const S3_CLIENT_TOKEN = Symbol.for('S3Client');

/** Creates an S3Client configured for the endpoint and credentials in AtlasConfig. */
export function create_s3_client(config: AtlasConfig): S3Client {
  return new S3Client({
    endpoint: config.s3_endpoint,
    region: config.s3_region,
    credentials: {
      accessKeyId: config.s3_access_key,
      secretAccessKey: config.s3_secret_key,
    },
    forcePathStyle: true,
  });
}
