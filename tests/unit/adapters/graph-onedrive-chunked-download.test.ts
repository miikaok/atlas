import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  download_file_chunked,
  compute_chunk_timeout_ms,
  CHUNK_SIZE_BYTES,
} from '@/adapters/m365/graph-onedrive-chunked-download';

const SMALL_FILE = CHUNK_SIZE_BYTES + 100;
const EXACT_FILE = CHUNK_SIZE_BYTES * 3;

describe('graph-onedrive-chunked-download', () => {
  let original_fetch: typeof globalThis.fetch;

  beforeEach(() => {
    vi.useFakeTimers();
    original_fetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = original_fetch;
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.clearAllTimers();
  });

  describe('compute_chunk_timeout_ms', () => {
    it('returns minimum 30s for small chunks', () => {
      expect(compute_chunk_timeout_ms(1024)).toBe(30_000);
    });

    it('scales with chunk size beyond minimum', () => {
      const large_chunk = 100 * 1024 * 1024;
      const timeout = compute_chunk_timeout_ms(large_chunk);
      expect(timeout).toBeGreaterThan(30_000);
    });
  });

  describe('download_file_chunked', () => {
    it('sends correct Range headers for each chunk', async () => {
      const calls: string[] = [];
      globalThis.fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        const range = (init?.headers as Record<string, string>)?.Range ?? '';
        calls.push(range);
        const chunk_data = Buffer.alloc(CHUNK_SIZE_BYTES, 0x42);
        return new Response(chunk_data, { status: 206 });
      }) as typeof fetch;

      await download_file_chunked('https://dl.example/file', EXACT_FILE, 'item-1');

      expect(calls).toHaveLength(3);
      expect(calls[0]).toBe(`bytes=0-${CHUNK_SIZE_BYTES - 1}`);
      expect(calls[1]).toBe(`bytes=${CHUNK_SIZE_BYTES}-${CHUNK_SIZE_BYTES * 2 - 1}`);
      expect(calls[2]).toBe(`bytes=${CHUNK_SIZE_BYTES * 2}-${EXACT_FILE - 1}`);
    });

    it('assembles chunks into correct final buffer', async () => {
      globalThis.fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        const range = (init?.headers as Record<string, string>)?.Range ?? '';
        const match = range.match(/bytes=(\d+)-(\d+)/);
        const start = Number(match?.[1] ?? 0);
        const end = Number(match?.[2] ?? 0);
        const length = end - start + 1;
        const fill = start === 0 ? 0xaa : 0xbb;
        return new Response(Buffer.alloc(length, fill), { status: 206 });
      }) as typeof fetch;

      const result = await download_file_chunked('https://dl.example/file', SMALL_FILE, 'item-2');

      expect(result.length).toBe(SMALL_FILE);
      expect(result[0]).toBe(0xaa);
      expect(result[CHUNK_SIZE_BYTES]).toBe(0xbb);
    });

    it('retries a failed chunk and succeeds', async () => {
      let call_count = 0;
      globalThis.fetch = vi.fn(async () => {
        call_count++;
        if (call_count === 1) {
          throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
        }
        return new Response(Buffer.alloc(CHUNK_SIZE_BYTES, 0x01), { status: 206 });
      }) as typeof fetch;

      const promise = download_file_chunked('https://dl.example/file', CHUNK_SIZE_BYTES, 'item-3');
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result.length).toBe(CHUNK_SIZE_BYTES);
      expect(call_count).toBe(2);
    });

    it('throws after exhausting all retry attempts on a chunk', async () => {
      globalThis.fetch = vi.fn(async () => {
        throw Object.assign(new Error('fetch failed'), { code: 'ETIMEDOUT' });
      }) as typeof fetch;

      const promise = download_file_chunked('https://dl.example/file', CHUNK_SIZE_BYTES, 'item-4');
      const assertion = expect(promise).rejects.toThrow(/after 6 attempts/);
      await vi.runAllTimersAsync();
      await assertion;
    });

    it('does not retry non-retryable errors', async () => {
      let call_count = 0;
      globalThis.fetch = vi.fn(async () => {
        call_count++;
        throw new Error('forbidden: 403');
      }) as typeof fetch;

      await expect(
        download_file_chunked('https://dl.example/file', CHUNK_SIZE_BYTES, 'item-5'),
      ).rejects.toThrow(/after 1 attempts/);
      expect(call_count).toBe(1);
    });
  });
});
