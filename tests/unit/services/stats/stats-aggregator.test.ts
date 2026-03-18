import { describe, it, expect } from 'vitest';
import type { Manifest, ManifestEntry } from '@/domain/manifest';
import {
  aggregate_bucket_stats,
  aggregate_mailbox_stats,
  aggregate_folder_stats,
  aggregate_monthly_breakdown,
} from '@/services/stats/stats-aggregator';

function make_entry(overrides: Partial<ManifestEntry> = {}): ManifestEntry {
  return {
    object_id: 'obj-1',
    storage_key: 'data/u/abc',
    checksum: 'abc',
    size_bytes: 100,
    ...overrides,
  };
}

function make_manifest(overrides: Partial<Manifest> = {}): Manifest {
  return {
    id: 'manifest-1',
    tenant_id: 't',
    mailbox_id: 'user@test.com',
    snapshot_id: 'snap-1',
    created_at: new Date('2026-03-01T10:00:00Z'),
    total_objects: 1,
    total_size_bytes: 100,
    delta_links: {},
    entries: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// aggregate_bucket_stats
// ---------------------------------------------------------------------------

describe('aggregate_bucket_stats', () => {
  it('returns zeroed stats for empty manifests', () => {
    const result = aggregate_bucket_stats('t', []);

    expect(result.tenant_id).toBe('t');
    expect(result.mailbox_count).toBe(0);
    expect(result.snapshot_count).toBe(0);
    expect(result.total_messages).toBe(0);
    expect(result.total_size_bytes).toBe(0);
    expect(result.attachment_count).toBe(0);
    expect(result.attachment_size_bytes).toBe(0);
    expect(result.monthly_breakdown).toEqual([]);
  });

  it('counts distinct mailboxes and sums across snapshots', () => {
    const manifests = [
      make_manifest({
        mailbox_id: 'alice@test.com',
        snapshot_id: 's1',
        entries: [make_entry({ size_bytes: 200 }), make_entry({ size_bytes: 300 })],
      }),
      make_manifest({
        mailbox_id: 'alice@test.com',
        snapshot_id: 's2',
        entries: [make_entry({ size_bytes: 150 })],
      }),
      make_manifest({
        mailbox_id: 'bob@test.com',
        snapshot_id: 's3',
        entries: [make_entry({ size_bytes: 400 })],
      }),
    ];

    const result = aggregate_bucket_stats('t', manifests);

    expect(result.mailbox_count).toBe(2);
    expect(result.snapshot_count).toBe(3);
    expect(result.total_messages).toBe(4);
    expect(result.total_size_bytes).toBe(1050);
  });

  it('accumulates attachment counts and sizes', () => {
    const manifests = [
      make_manifest({
        entries: [
          make_entry({
            size_bytes: 100,
            attachments: [
              {
                attachment_id: 'a1',
                name: 'f.pdf',
                content_type: 'application/pdf',
                size_bytes: 500,
                storage_key: 'att/x',
                checksum: 'x',
                is_inline: false,
              },
              {
                attachment_id: 'a2',
                name: 'g.png',
                content_type: 'image/png',
                size_bytes: 300,
                storage_key: 'att/y',
                checksum: 'y',
                is_inline: true,
              },
            ],
          }),
          make_entry({ size_bytes: 50 }),
        ],
      }),
    ];

    const result = aggregate_bucket_stats('t', manifests);

    expect(result.total_messages).toBe(2);
    expect(result.attachment_count).toBe(2);
    expect(result.attachment_size_bytes).toBe(800);
    expect(result.total_size_bytes).toBe(100 + 500 + 300 + 50);
  });

  it('builds monthly breakdown grouped and sorted', () => {
    const manifests = [
      make_manifest({
        created_at: new Date('2026-01-15'),
        entries: [make_entry({ size_bytes: 100 })],
      }),
      make_manifest({
        created_at: new Date('2026-03-10'),
        entries: [make_entry({ size_bytes: 200 })],
      }),
      make_manifest({
        created_at: new Date('2026-01-20'),
        entries: [make_entry({ size_bytes: 150 })],
      }),
    ];

    const result = aggregate_bucket_stats('t', manifests);

    expect(result.monthly_breakdown).toHaveLength(2);
    expect(result.monthly_breakdown[0]!.month).toBe('2026-01');
    expect(result.monthly_breakdown[0]!.snapshot_count).toBe(2);
    expect(result.monthly_breakdown[0]!.message_count).toBe(2);
    expect(result.monthly_breakdown[0]!.size_bytes).toBe(250);
    expect(result.monthly_breakdown[1]!.month).toBe('2026-03');
    expect(result.monthly_breakdown[1]!.snapshot_count).toBe(1);
    expect(result.monthly_breakdown[1]!.size_bytes).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// aggregate_mailbox_stats
// ---------------------------------------------------------------------------

describe('aggregate_mailbox_stats', () => {
  it('returns zeroed stats for empty manifests', () => {
    const result = aggregate_mailbox_stats('user@test.com', []);

    expect(result.mailbox_id).toBe('user@test.com');
    expect(result.snapshot_count).toBe(0);
    expect(result.total_messages).toBe(0);
    expect(result.total_size_bytes).toBe(0);
    expect(result.attachment_count).toBe(0);
    expect(result.attachment_size_bytes).toBe(0);
    expect(result.folders).toEqual([]);
    expect(result.monthly_breakdown).toEqual([]);
  });

  it('aggregates messages and attachments across snapshots', () => {
    const manifests = [
      make_manifest({
        entries: [
          make_entry({
            size_bytes: 200,
            folder_id: 'inbox',
            attachments: [
              {
                attachment_id: 'a1',
                name: 'f.pdf',
                content_type: 'application/pdf',
                size_bytes: 100,
                storage_key: 'att/x',
                checksum: 'x',
                is_inline: false,
              },
            ],
          }),
        ],
      }),
      make_manifest({
        entries: [make_entry({ size_bytes: 300, folder_id: 'sent' })],
      }),
    ];

    const result = aggregate_mailbox_stats('user@test.com', manifests);

    expect(result.snapshot_count).toBe(2);
    expect(result.total_messages).toBe(2);
    expect(result.total_size_bytes).toBe(200 + 100 + 300);
    expect(result.attachment_count).toBe(1);
    expect(result.attachment_size_bytes).toBe(100);
  });

  it('groups entries by folder_id', () => {
    const manifests = [
      make_manifest({
        entries: [
          make_entry({ size_bytes: 100, folder_id: 'inbox' }),
          make_entry({ size_bytes: 200, folder_id: 'sent' }),
          make_entry({ size_bytes: 150, folder_id: 'inbox' }),
        ],
      }),
    ];

    const result = aggregate_mailbox_stats('user@test.com', manifests);

    expect(result.folders).toHaveLength(2);
    const inbox = result.folders.find((f) => f.folder_id === 'inbox')!;
    expect(inbox.message_count).toBe(2);
    expect(inbox.total_size_bytes).toBe(250);

    const sent = result.folders.find((f) => f.folder_id === 'sent')!;
    expect(sent.message_count).toBe(1);
    expect(sent.total_size_bytes).toBe(200);
  });

  it('assigns "unknown" folder_id when entry has no folder_id', () => {
    const manifests = [
      make_manifest({
        entries: [make_entry({ size_bytes: 100 })],
      }),
    ];

    const result = aggregate_mailbox_stats('user@test.com', manifests);

    expect(result.folders).toHaveLength(1);
    expect(result.folders[0]!.folder_id).toBe('unknown');
  });

  it('sorts folders alphabetically', () => {
    const manifests = [
      make_manifest({
        entries: [
          make_entry({ folder_id: 'sent' }),
          make_entry({ folder_id: 'archive' }),
          make_entry({ folder_id: 'inbox' }),
        ],
      }),
    ];

    const result = aggregate_mailbox_stats('user@test.com', manifests);

    expect(result.folders.map((f) => f.folder_id)).toEqual(['archive', 'inbox', 'sent']);
  });
});

// ---------------------------------------------------------------------------
// aggregate_folder_stats
// ---------------------------------------------------------------------------

describe('aggregate_folder_stats', () => {
  it('returns empty array for no entries', () => {
    expect(aggregate_folder_stats([])).toEqual([]);
  });

  it('groups entries by folder and accumulates sizes', () => {
    const entries = [
      make_entry({
        folder_id: 'inbox',
        size_bytes: 100,
        attachments: [
          {
            attachment_id: 'a1',
            name: 'f.txt',
            content_type: 'text/plain',
            size_bytes: 50,
            storage_key: 'att/a',
            checksum: 'a',
            is_inline: false,
          },
        ],
      }),
      make_entry({ folder_id: 'inbox', size_bytes: 200 }),
      make_entry({ folder_id: 'sent', size_bytes: 300 }),
    ];

    const result = aggregate_folder_stats(entries);

    expect(result).toHaveLength(2);
    const inbox = result.find((f) => f.folder_id === 'inbox')!;
    expect(inbox.message_count).toBe(2);
    expect(inbox.total_size_bytes).toBe(100 + 50 + 200);
    expect(inbox.attachment_count).toBe(1);
    expect(inbox.attachment_size_bytes).toBe(50);

    const sent = result.find((f) => f.folder_id === 'sent')!;
    expect(sent.message_count).toBe(1);
    expect(sent.total_size_bytes).toBe(300);
    expect(sent.attachment_count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// aggregate_monthly_breakdown
// ---------------------------------------------------------------------------

describe('aggregate_monthly_breakdown', () => {
  it('returns empty array for no manifests', () => {
    expect(aggregate_monthly_breakdown([])).toEqual([]);
  });

  it('groups manifests by YYYY-MM and sorts chronologically', () => {
    const manifests = [
      make_manifest({
        created_at: new Date('2026-03-15'),
        entries: [make_entry({ size_bytes: 100 })],
      }),
      make_manifest({
        created_at: new Date('2026-01-10'),
        entries: [make_entry({ size_bytes: 200 })],
      }),
      make_manifest({
        created_at: new Date('2026-03-20'),
        entries: [
          make_entry({
            size_bytes: 50,
            attachments: [
              {
                attachment_id: 'a1',
                name: 'f.pdf',
                content_type: 'application/pdf',
                size_bytes: 25,
                storage_key: 'att/z',
                checksum: 'z',
                is_inline: false,
              },
            ],
          }),
        ],
      }),
    ];

    const result = aggregate_monthly_breakdown(manifests);

    expect(result).toHaveLength(2);
    expect(result[0]!.month).toBe('2026-01');
    expect(result[0]!.snapshot_count).toBe(1);
    expect(result[0]!.message_count).toBe(1);
    expect(result[0]!.size_bytes).toBe(200);
    expect(result[0]!.attachment_count).toBe(0);

    expect(result[1]!.month).toBe('2026-03');
    expect(result[1]!.snapshot_count).toBe(2);
    expect(result[1]!.message_count).toBe(2);
    expect(result[1]!.size_bytes).toBe(175);
    expect(result[1]!.attachment_count).toBe(1);
    expect(result[1]!.attachment_size_bytes).toBe(25);
  });

  it('handles manifests with no entries', () => {
    const manifests = [make_manifest({ created_at: new Date('2026-06-01'), entries: [] })];

    const result = aggregate_monthly_breakdown(manifests);

    expect(result).toHaveLength(1);
    expect(result[0]!.month).toBe('2026-06');
    expect(result[0]!.snapshot_count).toBe(1);
    expect(result[0]!.message_count).toBe(0);
    expect(result[0]!.size_bytes).toBe(0);
  });
});
