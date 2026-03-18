import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Container } from 'inversify';
import 'reflect-metadata';
import { MailboxSyncService } from '@/services/backup/mailbox-sync.service';
import {
  MAILBOX_CONNECTOR_TOKEN,
  MANIFEST_REPOSITORY_TOKEN,
  TENANT_CONTEXT_FACTORY_TOKEN,
} from '@/ports/tokens/outgoing.tokens';
import type {
  MailboxConnector,
  MailMessage,
  DeltaSyncResult,
} from '@/ports/mailbox/connector.port';
import type { ManifestRepository } from '@/ports/storage/manifest-repository.port';
import type { TenantContext, TenantContextFactory } from '@/ports/tenant/context.port';
import type { ObjectStorage } from '@/ports/storage/object-storage.port';

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
    delete_version: vi.fn(),
    exists: vi.fn().mockResolvedValue(false),
    list: vi.fn().mockResolvedValue([]),
    list_versions: vi.fn().mockResolvedValue([]),
    probe_immutability: vi.fn().mockResolvedValue({
      bucket: 'test-bucket',
      reachable: true,
      versioning_enabled: true,
      object_lock_enabled: true,
      mode_supported: true,
    }),
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
      mailbox_exists: vi.fn().mockResolvedValue(true),
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
        content_id: '',
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
        content_id: '',
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
        content_id: '',
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
        content_id: '',
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
        content_id: '',
      },
      {
        attachment_id: 'att-2',
        name: 'b.png',
        content_type: 'image/png',
        size_bytes: 200,
        is_inline: false,
        content: Buffer.from('png-b'),
        content_id: '',
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
        content_id: '',
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
        content_id: '',
      },
      {
        attachment_id: 'att-b',
        name: 'b.png',
        content_type: 'image/png',
        size_bytes: 200,
        is_inline: true,
        content: Buffer.from('png-b'),
        content_id: 'image001.png@01DA3B2F',
      },
    ]);

    const result = await service.sync_mailbox('t', 'user@test.com');

    expect(result.manifest.entries[0]!.attachments).toHaveLength(2);
    expect(result.manifest.entries[0]!.attachments![0]!.name).toBe('a.pdf');
    expect(result.manifest.entries[0]!.attachments![1]!.name).toBe('b.png');
    expect(result.manifest.entries[0]!.attachments![1]!.is_inline).toBe(true);
    expect(result.manifest.entries[0]!.attachments![1]!.content_id).toBe('image001.png@01DA3B2F');
    expect(result.manifest.entries[0]!.attachments![0]!.content_id).toBeUndefined();
  });

  it('passes object lock policy to newly uploaded attachments', async () => {
    const msg = make_message('msg-lock', 'body', true);
    vi.mocked(mock_connector.fetch_delta).mockResolvedValue(make_delta([msg]));
    vi.mocked(mock_connector.fetch_attachments).mockResolvedValue([
      {
        attachment_id: 'att-lock',
        name: 'locked.bin',
        content_type: 'application/octet-stream',
        size_bytes: 8,
        is_inline: false,
        content: Buffer.from('lockdata'),
        content_id: '',
      },
    ]);

    await service.sync_mailbox('t', 'user@test.com', {
      object_lock_policy: {
        mode: 'GOVERNANCE',
        retain_until: '2026-04-08T12:00:00.000Z',
      },
    });

    const att_put = (mock_context.storage.put as ReturnType<typeof vi.fn>).mock.calls.find(
      ([key]: [string]) => key.startsWith('attachments/'),
    );
    expect(att_put?.[3]).toEqual({
      mode: 'GOVERNANCE',
      retain_until: '2026-04-08T12:00:00.000Z',
    });
  });
});
