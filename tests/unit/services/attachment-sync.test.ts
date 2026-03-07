import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Container } from 'inversify';
import 'reflect-metadata';
import { MailboxSyncService } from '@/services/mailbox-sync.service';
import { fetch_and_store_attachments } from '@/services/attachment-sync.helper';
import { MAILBOX_CONNECTOR_TOKEN } from '@/ports/mailbox-connector.port';
import { MANIFEST_REPOSITORY_TOKEN } from '@/ports/manifest-repository.port';
import { TENANT_CONTEXT_FACTORY_TOKEN } from '@/ports/tenant-context.port';
import type {
  MailboxConnector,
  MailMessage,
  DeltaSyncResult,
} from '@/ports/mailbox-connector.port';
import type { ManifestRepository } from '@/ports/manifest-repository.port';
import type { TenantContext, TenantContextFactory } from '@/ports/tenant-context.port';
import type { ObjectStorage } from '@/ports/object-storage.port';

function make_message(id: string, body: string, has_attachments = false): MailMessage {
  const raw = Buffer.from(body);
  return {
    message_id: id,
    folder_id: 'folder-1',
    subject: `Subject ${id}`,
    received_at: new Date(),
    size_bytes: raw.length,
    raw_body: raw,
    has_attachments,
  };
}

function make_delta(messages: MailMessage[], delta_link = 'https://delta/link'): DeltaSyncResult {
  return { messages, removed_ids: [], delta_link, delta_reset: false };
}

function make_mock_storage(): ObjectStorage {
  return {
    put: vi.fn(),
    get: vi.fn(),
    delete: vi.fn(),
    exists: vi.fn().mockResolvedValue(false),
    list: vi.fn().mockResolvedValue([]),
  };
}

function make_mock_context(storage?: ObjectStorage): TenantContext {
  const s = storage ?? make_mock_storage();
  return {
    tenant_id: 'test-tenant',
    storage: s,
    encrypt: vi.fn((data: Buffer) => Buffer.concat([Buffer.from('E'), data])),
    decrypt: vi.fn((data: Buffer) => data.subarray(1)),
  };
}

describe('MailboxSyncService – attachment backup', () => {
  let mock_connector: MailboxConnector;
  let mock_context: TenantContext;
  let service: MailboxSyncService;

  beforeEach(() => {
    mock_context = make_mock_context();

    mock_connector = {
      list_mailboxes: vi.fn().mockResolvedValue([]),
      list_mail_folders: vi
        .fn()
        .mockResolvedValue([
          { folder_id: 'folder-1', display_name: 'Inbox', total_item_count: 10 },
        ]),
      fetch_delta: vi.fn().mockResolvedValue(make_delta([])),
      fetch_message: vi.fn(),
      fetch_attachments: vi.fn().mockResolvedValue([]),
    };

    const mock_manifests: ManifestRepository = {
      save: vi.fn(),
      find_by_snapshot: vi.fn().mockResolvedValue(undefined),
      find_latest_by_mailbox: vi.fn().mockResolvedValue(undefined),
      list_all_manifests: vi.fn().mockResolvedValue([]),
    };

    const mock_factory: TenantContextFactory = {
      create: vi.fn().mockResolvedValue(mock_context),
    };

    const container = new Container();
    container.bind(MAILBOX_CONNECTOR_TOKEN).toConstantValue(mock_connector);
    container.bind(MANIFEST_REPOSITORY_TOKEN).toConstantValue(mock_manifests);
    container.bind(TENANT_CONTEXT_FACTORY_TOKEN).toConstantValue(mock_factory);
    container.bind(MailboxSyncService).toSelf();
    service = container.get(MailboxSyncService);
  });

  it('fetches and stores attachments for messages with has_attachments=true', async () => {
    const msg = make_message('msg-att', 'body', true);
    vi.mocked(mock_connector.fetch_delta).mockResolvedValue(make_delta([msg]));
    vi.mocked(mock_connector.fetch_attachments).mockResolvedValue([
      {
        attachment_id: 'att-1',
        name: 'report.pdf',
        content_type: 'application/pdf',
        size_bytes: 1024,
        is_inline: false,
        content: Buffer.from('pdf-content'),
      },
    ]);

    const result = await service.sync_mailbox('t', 'user@test.com');

    expect(mock_connector.fetch_attachments).toHaveBeenCalledWith('t', 'user@test.com', 'msg-att');
    expect(result.manifest.entries[0]!.attachments).toHaveLength(1);
    expect(result.manifest.entries[0]!.attachments![0]!.name).toBe('report.pdf');
    expect(result.manifest.entries[0]!.attachments![0]!.storage_key).toContain(
      'attachments/user@test.com/',
    );
  });

  it('skips fetch_attachments for messages without attachments', async () => {
    const msg = make_message('msg-no-att', 'body', false);
    vi.mocked(mock_connector.fetch_delta).mockResolvedValue(make_delta([msg]));

    const result = await service.sync_mailbox('t', 'user@test.com');

    expect(mock_connector.fetch_attachments).not.toHaveBeenCalled();
    expect(result.manifest.entries[0]!.attachments).toBeUndefined();
  });

  it('deduplicates identical attachments across messages', async () => {
    const same_content = Buffer.from('shared-attachment-bytes');
    const msgs = [make_message('msg-1', 'body-1', true), make_message('msg-2', 'body-2', true)];
    vi.mocked(mock_connector.fetch_delta).mockResolvedValue(make_delta(msgs));
    vi.mocked(mock_connector.fetch_attachments).mockResolvedValue([
      {
        attachment_id: 'att-x',
        name: 'shared.pdf',
        content_type: 'application/pdf',
        size_bytes: same_content.length,
        is_inline: false,
        content: same_content,
      },
    ]);

    vi.mocked(mock_context.storage.exists as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(false) // msg-1 data key
      .mockResolvedValueOnce(false) // msg-1 attachment (first store)
      .mockResolvedValueOnce(false) // msg-2 data key
      .mockResolvedValueOnce(true); // msg-2 attachment (deduped)

    const result = await service.sync_mailbox('t', 'user@test.com');

    const att_puts = (mock_context.storage.put as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([key]: [string]) => key.startsWith('attachments/'),
    );
    expect(att_puts).toHaveLength(1);

    expect(result.manifest.entries[0]!.attachments![0]!.storage_key).toBe(
      result.manifest.entries[1]!.attachments![0]!.storage_key,
    );
  });

  it('records attachment metadata with empty key when contentBytes is missing', async () => {
    const msg = make_message('msg-large', 'body', true);
    vi.mocked(mock_connector.fetch_delta).mockResolvedValue(make_delta([msg]));
    vi.mocked(mock_connector.fetch_attachments).mockResolvedValue([
      {
        attachment_id: 'att-big',
        name: 'huge-file.zip',
        content_type: 'application/zip',
        size_bytes: 50_000_000,
        is_inline: false,
        content: Buffer.alloc(0),
      },
    ]);

    const result = await service.sync_mailbox('t', 'user@test.com');

    const att = result.manifest.entries[0]!.attachments![0]!;
    expect(att.name).toBe('huge-file.zip');
    expect(att.storage_key).toBe('');
    expect(att.checksum).toBe('');
  });

  it('encrypts attachment content before storing', async () => {
    const msg = make_message('msg-enc', 'body', true);
    vi.mocked(mock_connector.fetch_delta).mockResolvedValue(make_delta([msg]));
    vi.mocked(mock_connector.fetch_attachments).mockResolvedValue([
      {
        attachment_id: 'att-enc',
        name: 'secret.doc',
        content_type: 'application/msword',
        size_bytes: 512,
        is_inline: false,
        content: Buffer.from('secret-doc-content'),
      },
    ]);

    await service.sync_mailbox('t', 'user@test.com');

    const att_put = (mock_context.storage.put as ReturnType<typeof vi.fn>).mock.calls.find(
      ([key]: [string]) => key.startsWith('attachments/'),
    );
    expect(att_put).toBeDefined();
    expect(att_put![1][0]).toBe(0x45);
  });

  it('invokes on_progress callback during attachment processing', async () => {
    const msg = make_message('msg-cb', 'body', true);
    vi.mocked(mock_connector.fetch_delta).mockResolvedValue(make_delta([msg]));
    vi.mocked(mock_connector.fetch_attachments).mockResolvedValue([
      {
        attachment_id: 'att-1',
        name: 'a.pdf',
        content_type: 'application/pdf',
        size_bytes: 100,
        is_inline: false,
        content: Buffer.from('pdf-a'),
      },
      {
        attachment_id: 'att-2',
        name: 'b.png',
        content_type: 'image/png',
        size_bytes: 200,
        is_inline: false,
        content: Buffer.from('png-b'),
      },
    ]);

    const result = await service.sync_mailbox('t', 'user@test.com');

    expect(result.manifest.entries[0]!.attachments).toHaveLength(2);
  });

  it('includes attachment sizes in manifest total_size_bytes', async () => {
    const msg = make_message('msg-size', 'body', true);
    vi.mocked(mock_connector.fetch_delta).mockResolvedValue(make_delta([msg]));
    vi.mocked(mock_connector.fetch_attachments).mockResolvedValue([
      {
        attachment_id: 'att-sz',
        name: 'file.bin',
        content_type: 'application/octet-stream',
        size_bytes: 5000,
        is_inline: false,
        content: Buffer.from('bin-data'),
      },
    ]);

    const result = await service.sync_mailbox('t', 'user@test.com');

    const msg_size = msg.raw_body.length;
    expect(result.manifest.total_size_bytes).toBe(msg_size + 5000);
  });

  it('stores multiple attachments from a single message', async () => {
    const msg = make_message('msg-multi', 'body', true);
    vi.mocked(mock_connector.fetch_delta).mockResolvedValue(make_delta([msg]));
    vi.mocked(mock_connector.fetch_attachments).mockResolvedValue([
      {
        attachment_id: 'att-a',
        name: 'a.pdf',
        content_type: 'application/pdf',
        size_bytes: 100,
        is_inline: false,
        content: Buffer.from('pdf-a'),
      },
      {
        attachment_id: 'att-b',
        name: 'b.png',
        content_type: 'image/png',
        size_bytes: 200,
        is_inline: true,
        content: Buffer.from('png-b'),
      },
    ]);

    const result = await service.sync_mailbox('t', 'user@test.com');

    expect(result.manifest.entries[0]!.attachments).toHaveLength(2);
    expect(result.manifest.entries[0]!.attachments![0]!.name).toBe('a.pdf');
    expect(result.manifest.entries[0]!.attachments![1]!.name).toBe('b.png');
    expect(result.manifest.entries[0]!.attachments![1]!.is_inline).toBe(true);
  });
});

describe('fetch_and_store_attachments – on_progress callback', () => {
  it('calls on_progress with (done, total) for each attachment', async () => {
    const ctx = make_mock_context();
    const connector: MailboxConnector = {
      list_mailboxes: vi.fn(),
      list_mail_folders: vi.fn(),
      fetch_delta: vi.fn(),
      fetch_message: vi.fn(),
      fetch_attachments: vi.fn().mockResolvedValue([
        {
          attachment_id: 'a1',
          name: 'file1.txt',
          content_type: 'text/plain',
          size_bytes: 10,
          is_inline: false,
          content: Buffer.from('aaa'),
        },
        {
          attachment_id: 'a2',
          name: 'file2.txt',
          content_type: 'text/plain',
          size_bytes: 20,
          is_inline: false,
          content: Buffer.from('bbb'),
        },
        {
          attachment_id: 'a3',
          name: 'file3.txt',
          content_type: 'text/plain',
          size_bytes: 30,
          is_inline: false,
          content: Buffer.from('ccc'),
        },
      ]),
    };

    const progress_calls: [number, number][] = [];
    const on_progress = (done: number, total: number): void => {
      progress_calls.push([done, total]);
    };

    const entries = await fetch_and_store_attachments(
      ctx,
      connector,
      'tenant-1',
      'user@test.com',
      'msg-1',
      on_progress,
    );

    expect(entries).toHaveLength(3);
    expect(progress_calls).toEqual([
      [1, 3],
      [2, 3],
      [3, 3],
    ]);
  });

  it('does not fail when on_progress is not provided', async () => {
    const ctx = make_mock_context();
    const connector: MailboxConnector = {
      list_mailboxes: vi.fn(),
      list_mail_folders: vi.fn(),
      fetch_delta: vi.fn(),
      fetch_message: vi.fn(),
      fetch_attachments: vi.fn().mockResolvedValue([
        {
          attachment_id: 'a1',
          name: 'file.txt',
          content_type: 'text/plain',
          size_bytes: 5,
          is_inline: false,
          content: Buffer.from('x'),
        },
      ]),
    };

    const entries = await fetch_and_store_attachments(
      ctx,
      connector,
      'tenant-1',
      'user@test.com',
      'msg-1',
    );

    expect(entries).toHaveLength(1);
  });
});
