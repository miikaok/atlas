import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { download_with_retry } from '@/services/onedrive/onedrive-download-orchestrator';
import type { OneDriveConnector, OneDriveDeltaItem } from '@/ports/onedrive/connector.port';

function make_item(overrides: Partial<OneDriveDeltaItem> = {}): OneDriveDeltaItem {
  return {
    item_id: 'f1',
    drive_id: 'd1',
    kind: 'file',
    file_name: 'report.pdf',
    parent_path: '/Documents',
    size_bytes: 5_000_000,
    deleted: false,
    ...overrides,
  };
}

describe('onedrive-download-orchestrator', () => {
  let connector: OneDriveConnector;

  beforeEach(() => {
    vi.useFakeTimers();
    connector = {
      list_drives: vi.fn(),
      fetch_delta: vi.fn(),
      download_file_content: vi.fn(),
      resolve_download_url: vi.fn(),
    };
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.clearAllTimers();
  });

  it('returns buffer on first successful attempt', async () => {
    const body = Buffer.from('file-content');
    vi.mocked(connector.download_file_content).mockResolvedValue(body);

    const result = await download_with_retry(connector, make_item());

    expect(result).toBe(body);
    expect(connector.download_file_content).toHaveBeenCalledOnce();
  });

  it('retries on retryable error and succeeds on second attempt', async () => {
    const body = Buffer.from('recovered');
    vi.mocked(connector.download_file_content)
      .mockRejectedValueOnce(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }))
      .mockResolvedValueOnce(body);

    const promise = download_with_retry(connector, make_item());
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toBe(body);
    expect(connector.download_file_content).toHaveBeenCalledTimes(2);
  });

  it('returns undefined after exhausting all attempts on retryable errors', async () => {
    vi.mocked(connector.download_file_content).mockRejectedValue(
      Object.assign(new Error('fetch failed'), { code: 'ETIMEDOUT' }),
    );

    const promise = download_with_retry(connector, make_item(), { max_attempts: 2 });
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toBeUndefined();
    expect(connector.download_file_content).toHaveBeenCalledTimes(2);
  });

  it('returns undefined immediately on non-retryable errors', async () => {
    vi.mocked(connector.download_file_content).mockRejectedValue(
      new Error('403 Forbidden: access denied'),
    );

    const result = await download_with_retry(connector, make_item(), { max_attempts: 3 });

    expect(result).toBeUndefined();
    expect(connector.download_file_content).toHaveBeenCalledOnce();
  });

  it('respects configurable max_attempts', async () => {
    vi.mocked(connector.download_file_content).mockRejectedValue(
      Object.assign(new Error('fetch failed'), { code: 'ECONNRESET' }),
    );

    const promise = download_with_retry(connector, make_item(), { max_attempts: 5 });
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toBeUndefined();
    expect(connector.download_file_content).toHaveBeenCalledTimes(5);
  });
});
