import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetch_file_chunks, CHUNK_SIZE_BYTES } from '@/adapters/m365/graph-onedrive-chunk-fetcher';

const EXACT_FILE = CHUNK_SIZE_BYTES * 3;

describe('graph-onedrive-chunk-fetcher', () => {
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

  it('yields one buffer per chunk with correct Range headers', async () => {
    const ranges: string[] = [];
    globalThis.fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const range = (init?.headers as Record<string, string>)?.Range ?? '';
      ranges.push(range);
      const length = CHUNK_SIZE_BYTES;
      return new Response(Buffer.alloc(length, 0x42), { status: 206 });
    }) as typeof fetch;

    const chunks: Buffer[] = [];
    for await (const chunk of fetch_file_chunks('https://dl.example/file', EXACT_FILE, 'item-1')) {
      chunks.push(chunk);
    }

    expect(chunks).toHaveLength(3);
    expect(ranges[0]).toBe(`bytes=0-${CHUNK_SIZE_BYTES - 1}`);
    expect(ranges[2]).toBe(`bytes=${CHUNK_SIZE_BYTES * 2}-${EXACT_FILE - 1}`);
  });

  it('retries a failed chunk and yields the result', async () => {
    let call_count = 0;
    globalThis.fetch = vi.fn(async () => {
      call_count++;
      if (call_count === 1) {
        throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
      }
      return new Response(Buffer.alloc(CHUNK_SIZE_BYTES, 0x01), { status: 206 });
    }) as typeof fetch;

    const chunks: Buffer[] = [];
    const gen = fetch_file_chunks('https://dl.example/file', CHUNK_SIZE_BYTES, 'item-2');
    const promise = gen.next();
    await vi.runAllTimersAsync();
    const result = await promise;

    if (!result.done) chunks.push(result.value);
    expect(chunks).toHaveLength(1);
    expect(call_count).toBe(2);
  });

  it('does not retry non-retryable errors', async () => {
    let call_count = 0;
    globalThis.fetch = vi.fn(async () => {
      call_count++;
      throw new Error('forbidden: 403');
    }) as typeof fetch;

    const gen = fetch_file_chunks('https://dl.example/file', CHUNK_SIZE_BYTES, 'item-3');
    await expect(gen.next()).rejects.toThrow(/after 1 attempts/);
    expect(call_count).toBe(1);
  });
});
