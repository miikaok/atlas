import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ensure_bucket_exists, reset_bucket_cache } from '@/adapters/storage-s3/s3-bucket-manager';

function make_mock_s3() {
  return { send: vi.fn() };
}

describe('s3-bucket-manager', () => {
  let mock_s3: ReturnType<typeof make_mock_s3>;

  beforeEach(() => {
    mock_s3 = make_mock_s3();
    reset_bucket_cache();
  });

  it('creates bucket when it does not exist', async () => {
    mock_s3.send
      .mockRejectedValueOnce(Object.assign(new Error(), { name: 'NotFound' }))
      .mockResolvedValueOnce({});

    await ensure_bucket_exists(mock_s3 as never, 'new-bucket');

    expect(mock_s3.send).toHaveBeenCalledTimes(2);
    const create_cmd = mock_s3.send.mock.calls[1][0];
    expect(create_cmd.input.Bucket).toBe('new-bucket');
  });

  it('skips creation when bucket already exists', async () => {
    mock_s3.send.mockResolvedValueOnce({});

    await ensure_bucket_exists(mock_s3 as never, 'existing');
    expect(mock_s3.send).toHaveBeenCalledTimes(1);
  });

  it('caches after first check and skips on second call', async () => {
    mock_s3.send.mockResolvedValueOnce({});

    await ensure_bucket_exists(mock_s3 as never, 'cached');
    await ensure_bucket_exists(mock_s3 as never, 'cached');

    expect(mock_s3.send).toHaveBeenCalledTimes(1);
  });

  it('rethrows unexpected errors from HeadBucket', async () => {
    mock_s3.send.mockRejectedValueOnce(new Error('AccessDenied'));

    await expect(ensure_bucket_exists(mock_s3 as never, 'x')).rejects.toThrow('AccessDenied');
  });
});
