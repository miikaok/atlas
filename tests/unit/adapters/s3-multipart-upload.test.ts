import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { put_multipart, MULTIPART_THRESHOLD } from '@/adapters/storage-s3/s3-multipart-upload';

function make_mock_s3(): { send: ReturnType<typeof vi.fn> } {
  return { send: vi.fn() };
}

describe('s3-multipart-upload', () => {
  let mock_s3: ReturnType<typeof make_mock_s3>;
  const bucket = 'test-bucket';

  beforeEach(() => {
    vi.useFakeTimers();
    mock_s3 = make_mock_s3();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.clearAllTimers();
  });

  it('creates, uploads parts, and completes multipart upload', async () => {
    const part_size = 8 * 1024 * 1024;
    const data = Buffer.alloc(part_size * 2 + 100, 0xab);

    mock_s3.send
      .mockResolvedValueOnce({ UploadId: 'upload-123' })
      .mockResolvedValueOnce({ ETag: '"etag-1"' })
      .mockResolvedValueOnce({ ETag: '"etag-2"' })
      .mockResolvedValueOnce({ ETag: '"etag-3"' })
      .mockResolvedValueOnce({});

    await put_multipart(mock_s3 as never, bucket, 'onedrive/data/owner/sha256', data, {
      'x-custom': 'meta',
    });

    expect(mock_s3.send).toHaveBeenCalledTimes(5);

    const create_cmd = mock_s3.send.mock.calls[0][0];
    expect(create_cmd.input.Bucket).toBe(bucket);
    expect(create_cmd.input.Key).toBe('onedrive/data/owner/sha256');
    expect(create_cmd.input.Metadata).toEqual({ 'x-custom': 'meta' });

    const upload_cmd_1 = mock_s3.send.mock.calls[1][0];
    expect(upload_cmd_1.input.PartNumber).toBe(1);
    expect(upload_cmd_1.input.UploadId).toBe('upload-123');
    expect(upload_cmd_1.input.ContentMD5).toBeDefined();

    const complete_cmd = mock_s3.send.mock.calls[4][0];
    expect(complete_cmd.input.MultipartUpload.Parts).toHaveLength(3);
    expect(complete_cmd.input.MultipartUpload.Parts[0].ETag).toBe('"etag-1"');
    expect(complete_cmd.input.MultipartUpload.Parts[2].PartNumber).toBe(3);
  });

  it('aborts upload on part failure after exhausting retries', async () => {
    const data = Buffer.alloc(MULTIPART_THRESHOLD + 1, 0xcc);

    mock_s3.send
      .mockResolvedValueOnce({ UploadId: 'upload-fail' })
      .mockRejectedValue(new Error('S3 internal error'));

    const promise = put_multipart(mock_s3 as never, bucket, 'key', data);
    const assertion = expect(promise).rejects.toThrow(/failed after/);
    await vi.runAllTimersAsync();
    await assertion;

    const last_call = mock_s3.send.mock.calls.at(-1);
    expect(last_call).toBeDefined();
    expect((last_call![0] as { input: { UploadId?: string } }).input.UploadId).toBe('upload-fail');
  });

  it('passes object lock policy to CreateMultipartUpload', async () => {
    const data = Buffer.alloc(8 * 1024 * 1024 + 1, 0xdd);

    mock_s3.send
      .mockResolvedValueOnce({ UploadId: 'upload-lock' })
      .mockResolvedValueOnce({ ETag: '"etag-1"' })
      .mockResolvedValueOnce({ ETag: '"etag-2"' })
      .mockResolvedValueOnce({});

    await put_multipart(mock_s3 as never, bucket, 'key', data, undefined, {
      mode: 'GOVERNANCE',
      retain_until: '2027-01-01T00:00:00.000Z',
    });

    const create_cmd = mock_s3.send.mock.calls[0][0];
    expect(create_cmd.input.ObjectLockMode).toBe('GOVERNANCE');
    expect(create_cmd.input.ObjectLockRetainUntilDate).toBeInstanceOf(Date);
  });

  it('throws when CreateMultipartUpload returns no UploadId', async () => {
    const data = Buffer.alloc(MULTIPART_THRESHOLD + 1, 0xee);
    mock_s3.send.mockResolvedValueOnce({ UploadId: undefined });

    await expect(put_multipart(mock_s3 as never, bucket, 'key', data)).rejects.toThrow(
      /no UploadId/,
    );
  });
});
