import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Container } from 'inversify';
import { GraphMailboxConnector } from '@/adapters/m365/graph-mailbox-connector.adapter';
import { GRAPH_CLIENT_TOKEN } from '@/adapters/m365/graph-client.factory';

interface MockChain {
  select: ReturnType<typeof vi.fn>;
  top: ReturnType<typeof vi.fn>;
  header: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
}

interface MockClient {
  api: ReturnType<typeof vi.fn>;
  _chain: MockChain;
}

function create_mock_client(): MockClient {
  const get_fn = vi.fn();
  const chain: MockChain = {
    select: vi.fn(),
    top: vi.fn(),
    header: vi.fn(),
    get: get_fn,
  };
  chain.select.mockReturnValue(chain);
  chain.top.mockReturnValue(chain);
  chain.header.mockReturnValue(chain);

  const api_fn = vi.fn().mockReturnValue(chain);
  return { api: api_fn, _chain: chain };
}

function create_connector(mock_client: MockClient): GraphMailboxConnector {
  const container = new Container();
  container.bind(GRAPH_CLIENT_TOKEN).toConstantValue(mock_client);
  container.bind(GraphMailboxConnector).toSelf();
  return container.get(GraphMailboxConnector);
}

describe('GraphMailboxConnector', () => {
  let mock_client: MockClient;
  let connector: GraphMailboxConnector;

  beforeEach(() => {
    mock_client = create_mock_client();
    connector = create_connector(mock_client);
  });

  // ---------------------------------------------------------------------------
  // list_mailboxes
  // ---------------------------------------------------------------------------

  describe('list_mailboxes', () => {
    it('returns user IDs from a single page', async () => {
      mock_client._chain.get.mockResolvedValueOnce({
        value: [
          { id: 'user-1', mail: 'a@test.com', displayName: 'User A' },
          { id: 'user-2', mail: 'b@test.com', displayName: 'User B' },
        ],
      });

      const result = await connector.list_mailboxes('tenant-1');

      expect(result).toEqual(['user-1', 'user-2']);
    });

    it('paginates through multiple pages via @odata.nextLink', async () => {
      mock_client._chain.get
        .mockResolvedValueOnce({
          value: [{ id: 'user-1', mail: 'a@test.com' }],
          '@odata.nextLink': '/users?$skiptoken=page2',
        })
        .mockResolvedValueOnce({
          value: [{ id: 'user-2', mail: 'b@test.com' }],
        });

      const result = await connector.list_mailboxes('tenant-1');

      expect(result).toEqual(['user-1', 'user-2']);
      expect(mock_client.api).toHaveBeenCalledTimes(2);
    });

    it('skips users without an id', async () => {
      mock_client._chain.get.mockResolvedValueOnce({
        value: [{ id: 'user-1', mail: 'a@test.com' }, { mail: 'no-id@test.com' }],
      });

      const result = await connector.list_mailboxes('tenant-1');

      expect(result).toEqual(['user-1']);
    });
  });

  // ---------------------------------------------------------------------------
  // list_mail_folders
  // ---------------------------------------------------------------------------

  describe('list_mail_folders', () => {
    it('returns folders excluding system folders', async () => {
      mock_client._chain.get.mockResolvedValueOnce({
        value: [
          { id: 'f-inbox', displayName: 'Inbox', parentFolderId: 'root', totalItemCount: 42 },
          { id: 'f-sent', displayName: 'Sent Items', parentFolderId: 'root', totalItemCount: 10 },
          { id: 'f-drafts', displayName: 'Drafts', parentFolderId: 'root', totalItemCount: 3 },
          { id: 'f-outbox', displayName: 'Outbox', parentFolderId: 'root', totalItemCount: 0 },
          { id: 'f-junk', displayName: 'JunkEmail', parentFolderId: 'root', totalItemCount: 5 },
          { id: 'f-recover', displayName: 'RecoverableItemsDeletions', totalItemCount: 1 },
        ],
      });

      const result = await connector.list_mail_folders('tenant-1', 'user-1');

      const names = result.map((f) => f.display_name);
      expect(names).toEqual(['Inbox', 'Sent Items']);
      expect(result[0]).toEqual({
        folder_id: 'f-inbox',
        display_name: 'Inbox',
        parent_folder_id: 'root',
        total_item_count: 42,
      });
    });

    it('paginates through folder pages', async () => {
      mock_client._chain.get
        .mockResolvedValueOnce({
          value: [{ id: 'f-1', displayName: 'Inbox' }],
          '@odata.nextLink': '/next',
        })
        .mockResolvedValueOnce({
          value: [{ id: 'f-2', displayName: 'Archive' }],
        });

      const result = await connector.list_mail_folders('tenant-1', 'user-1');

      expect(result).toHaveLength(2);
    });
  });

  // ---------------------------------------------------------------------------
  // fetch_delta
  // ---------------------------------------------------------------------------

  describe('fetch_delta', () => {
    it('uses fluent API (.select/.top) for initial full sync', async () => {
      mock_client._chain.get.mockResolvedValueOnce({
        value: [
          {
            id: 'msg-1',
            subject: 'Hello',
            body: { contentType: 'text', content: 'hello body' },
            receivedDateTime: '2025-01-15T10:00:00Z',
            parentFolderId: 'f-inbox',
          },
        ],
        '@odata.deltaLink': 'https://graph.microsoft.com/delta?token=abc123',
      });

      const result = await connector.fetch_delta('tenant-1', 'user-1', 'f-inbox');

      expect(result.messages).toHaveLength(1);
      expect(result.messages[0]?.message_id).toBe('msg-1');
      expect(result.delta_link).toBe('https://graph.microsoft.com/delta?token=abc123');
      expect(result.delta_reset).toBe(false);

      expect(mock_client._chain.select).toHaveBeenCalled();
      expect(mock_client._chain.top).not.toHaveBeenCalled();
    });

    it('returns full messages directly from delta pages (no per-message fetches)', async () => {
      const graph_message = {
        id: 'msg-full',
        subject: 'Full body test',
        body: { contentType: 'html', content: '<p>Hello</p>' },
        importance: 'normal',
        receivedDateTime: '2025-03-01T12:00:00Z',
        parentFolderId: 'f-inbox',
      };

      mock_client._chain.get.mockResolvedValueOnce({
        value: [graph_message],
        '@odata.deltaLink': 'https://graph.microsoft.com/delta?token=x',
      });

      const result = await connector.fetch_delta('tenant-1', 'user-1', 'f-inbox');

      expect(mock_client._chain.get).toHaveBeenCalledTimes(1);

      const stored = JSON.parse(result.messages[0]!.raw_body.toString('utf-8'));
      expect(stored.body.content).toBe('<p>Hello</p>');
      expect(stored.importance).toBe('normal');
    });

    it('uses prev_delta_link directly for incremental sync', async () => {
      const prev_link = 'https://graph.microsoft.com/delta?token=prev123';

      mock_client._chain.get.mockResolvedValueOnce({
        value: [
          {
            id: 'msg-3',
            subject: 'New',
            receivedDateTime: '2025-02-01T10:00:00Z',
            parentFolderId: 'f-inbox',
          },
        ],
        '@odata.deltaLink': 'https://graph.microsoft.com/delta?token=new456',
      });

      const result = await connector.fetch_delta('tenant-1', 'user-1', 'f-inbox', prev_link);

      expect(mock_client.api).toHaveBeenCalledWith(prev_link);
      expect(result.messages).toHaveLength(1);
      expect(result.delta_link).toBe('https://graph.microsoft.com/delta?token=new456');
    });

    it('separates removed items from added items', async () => {
      mock_client._chain.get.mockResolvedValueOnce({
        value: [
          { id: 'msg-kept', subject: 'Kept', receivedDateTime: '2025-01-15T10:00:00Z' },
          { id: 'msg-deleted', '@removed': { reason: 'deleted' } },
          { id: 'msg-moved', '@removed': { reason: 'changed' } },
        ],
        '@odata.deltaLink': 'https://graph.microsoft.com/delta?token=after',
      });

      const result = await connector.fetch_delta('tenant-1', 'user-1', 'f-inbox');

      expect(result.messages).toHaveLength(1);
      expect(result.messages[0]?.message_id).toBe('msg-kept');
      expect(result.removed_ids).toEqual(['msg-deleted', 'msg-moved']);
    });

    it('follows @odata.nextLink across multiple delta pages', async () => {
      mock_client._chain.get
        .mockResolvedValueOnce({
          value: [{ id: 'msg-1', subject: 'Page 1' }],
          '@odata.nextLink': '/delta?skiptoken=page2',
        })
        .mockResolvedValueOnce({
          value: [{ id: 'msg-2', subject: 'Page 2' }],
          '@odata.deltaLink': 'https://graph.microsoft.com/delta?token=final',
        });

      const result = await connector.fetch_delta('tenant-1', 'user-1', 'f-inbox');

      expect(result.messages).toHaveLength(2);
      expect(result.delta_link).toBe('https://graph.microsoft.com/delta?token=final');
      expect(mock_client._chain.get).toHaveBeenCalledTimes(2);
    });

    it('falls back to full enumeration on invalid delta token', async () => {
      const stale_link = 'https://graph.microsoft.com/delta?token=stale';

      mock_client._chain.get
        .mockRejectedValueOnce(new Error('SyncStateNotFound: delta token expired'))
        .mockResolvedValueOnce({
          value: [{ id: 'msg-fresh', subject: 'Fresh sync' }],
          '@odata.deltaLink': 'https://graph.microsoft.com/delta?token=fresh',
        });

      const result = await connector.fetch_delta('tenant-1', 'user-1', 'f-inbox', stale_link);

      expect(result.delta_reset).toBe(true);
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0]?.message_id).toBe('msg-fresh');
    });

    it('rethrows non-delta errors without fallback', async () => {
      mock_client._chain.get.mockRejectedValueOnce(new Error('Network timeout'));

      await expect(connector.fetch_delta('tenant-1', 'user-1', 'f-inbox')).rejects.toThrow(
        'Network timeout',
      );
    });
  });

  // ---------------------------------------------------------------------------
  // fetch_message
  // ---------------------------------------------------------------------------

  describe('fetch_message', () => {
    it('fetches a single message and returns MailMessage shape', async () => {
      mock_client._chain.get.mockResolvedValueOnce({
        id: 'msg-single',
        subject: 'Single fetch',
        receivedDateTime: '2025-04-01T08:00:00Z',
        parentFolderId: 'f-sent',
        body: { content: 'single body' },
      });

      const result = await connector.fetch_message('tenant-1', 'user-1', 'msg-single');

      expect(result.message_id).toBe('msg-single');
      expect(result.subject).toBe('Single fetch');
      expect(result.folder_id).toBe('f-sent');
      expect(result.received_at).toEqual(new Date('2025-04-01T08:00:00Z'));
      expect(result.raw_body).toBeInstanceOf(Buffer);
      expect(result.size_bytes).toBeGreaterThan(0);
    });

    it('populates has_attachments from Graph response', async () => {
      mock_client._chain.get.mockResolvedValueOnce({
        id: 'msg-att',
        subject: 'With attachments',
        receivedDateTime: '2025-04-01T08:00:00Z',
        hasAttachments: true,
      });

      const result = await connector.fetch_message('tenant-1', 'user-1', 'msg-att');
      expect(result.has_attachments).toBe(true);
    });

    it('defaults has_attachments to false when not set', async () => {
      mock_client._chain.get.mockResolvedValueOnce({
        id: 'msg-no-att',
        subject: 'No attachments',
        receivedDateTime: '2025-04-01T08:00:00Z',
      });

      const result = await connector.fetch_message('tenant-1', 'user-1', 'msg-no-att');
      expect(result.has_attachments).toBe(false);
    });
  });
});
