import { describe, it, expect } from 'vitest';
import { tenant_bucket_name } from '@/adapters/storage-s3/tenant-bucket-name';

describe('tenant_bucket_name', () => {
  it('prefixes atlas-{tenant_id}', () => {
    expect(tenant_bucket_name('550e8400-e29b-41d4-a716-446655440000')).toBe(
      'atlas-550e8400-e29b-41d4-a716-446655440000',
    );
  });
});
