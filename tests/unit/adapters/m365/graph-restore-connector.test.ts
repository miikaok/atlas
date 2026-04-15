import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Container } from 'inversify';
import 'reflect-metadata';
import { GraphRestoreConnector } from '@/adapters/m365/graph-restore-connector.adapter';
import { GRAPH_CLIENT_TOKEN } from '@/adapters/m365/graph-client.factory';

function make_mock_client(): {
  api: ReturnType<typeof vi.fn>;
  post: ReturnType<typeof vi.fn>;
  put: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  header: ReturnType<typeof vi.fn>;
} {
  const client = {
    api: vi.fn().mockReturnThis(),
    post: vi.fn(),
    put: vi.fn(),
    get: vi.fn(),
    header: vi.fn().mockReturnThis(),
  };
  client.api.mockReturnValue(client);
  return client;
}

describe('GraphRestoreConnector', () => {
  let container: Container;
  let mock_client: ReturnType<typeof make_mock_client>;
  let connector: GraphRestoreConnector;

  beforeEach(() => {
    mock_client = make_mock_client();
    container = new Container();
    container.bind(GRAPH_CLIENT_TOKEN).toConstantValue(mock_client);
    container.bind(GraphRestoreConnector).toSelf();
    connector = container.get(GraphRestoreConnector);
  });

  describe('create_mail_folder', () => {
    it('creates a top-level folder', async () => {
      mock_client.post.mockResolvedValue({
        id: 'new-folder-id',
        displayName: 'Restore-2026-03-08',
        parentFolderId: undefined,
        totalItemCount: 0,
      });

      const result = await connector.create_mail_folder('t', 'user@test.com', 'Restore-2026-03-08');

      expect(result.folder_id).toBe('new-folder-id');
      expect(result.display_name).toBe('Restore-2026-03-08');
      expect(mock_client.api).toHaveBeenCalledWith('/users/user@test.com/mailFolders');
    });

    it('creates a child folder under a parent', async () => {
      mock_client.post.mockResolvedValue({
        id: 'child-id',
        displayName: 'Inbox',
      });

      await connector.create_mail_folder('t', 'user@test.com', 'Inbox', 'parent-id');

      expect(mock_client.api).toHaveBeenCalledWith(
        '/users/user@test.com/mailFolders/parent-id/childFolders',
      );
    });
  });

  describe('create_message', () => {
    it('creates a message and returns the ID', async () => {
      mock_client.post.mockResolvedValue({ id: 'new-msg-id' });

      const msg_id = await connector.create_message('t', 'user@test.com', 'folder-1', {
        subject: 'Test',
      });

      expect(msg_id).toBe('new-msg-id');
      expect(mock_client.api).toHaveBeenCalledWith(
        '/users/user@test.com/mailFolders/folder-1/messages',
      );
    });

    it('throws when Graph returns no ID', async () => {
      mock_client.post.mockResolvedValue({});

      await expect(
        connector.create_message('t', 'user@test.com', 'f1', { subject: 'Test' }),
      ).rejects.toThrow('Graph returned no message ID');
    });
  });

  describe('add_attachment', () => {
    it('uploads a small attachment inline', async () => {
      mock_client.post.mockResolvedValue({});
      const content = Buffer.from('file-data');

      await connector.add_attachment('t', 'user@test.com', 'msg-1', {
        name: 'doc.pdf',
        content_type: 'application/pdf',
        content,
        is_inline: false,
      });

      expect(mock_client.api).toHaveBeenCalledWith(
        '/users/user@test.com/messages/msg-1/attachments',
      );
      expect(mock_client.post).toHaveBeenCalledWith(
        expect.objectContaining({
          '@odata.type': '#microsoft.graph.fileAttachment',
          name: 'doc.pdf',
          contentBytes: content.toString('base64'),
        }),
      );
    });

    it('includes contentId in payload for inline attachments with content_id', async () => {
      mock_client.post.mockResolvedValue({});

      await connector.add_attachment('t', 'user@test.com', 'msg-1', {
        name: 'logo.png',
        content_type: 'image/png',
        content: Buffer.from('png-data'),
        is_inline: true,
        content_id: 'image001.png@01DA3B2F.5A7E8990',
      });

      expect(mock_client.post).toHaveBeenCalledWith(
        expect.objectContaining({
          isInline: true,
          contentId: 'image001.png@01DA3B2F.5A7E8990',
        }),
      );
    });

    it('omits contentId from payload when content_id is not set', async () => {
      mock_client.post.mockResolvedValue({});

      await connector.add_attachment('t', 'user@test.com', 'msg-1', {
        name: 'file.pdf',
        content_type: 'application/pdf',
        content: Buffer.from('pdf-data'),
        is_inline: false,
      });

      const payload = mock_client.post.mock.calls[0]![0] as Record<string, unknown>;
      expect(payload).not.toHaveProperty('contentId');
    });
  });

  describe('create_upload_session', () => {
    it('opens an upload session for large attachments', async () => {
      mock_client.post.mockResolvedValue({
        uploadUrl: 'https://upload.example.com/session',
        expirationDateTime: '2026-03-10T00:00:00Z',
      });

      const session = await connector.create_upload_session(
        't',
        'user@test.com',
        'msg-1',
        'bigfile.zip',
        10_000_000,
      );

      expect(session.upload_url).toBe('https://upload.example.com/session');
      expect(session.expiration).toBe('2026-03-10T00:00:00Z');
    });

    it('throws when uploadUrl is missing', async () => {
      mock_client.post.mockResolvedValue({});

      await expect(
        connector.create_upload_session('t', 'user@test.com', 'msg-1', 'f.bin', 1000),
      ).rejects.toThrow('no uploadUrl');
    });
  });

  describe('upload_attachment_chunk', () => {
    it('sends Content-Range and PUT body', async () => {
      mock_client.put.mockResolvedValue({});

      await connector.upload_attachment_chunk('https://upload.example/u', Buffer.from('ab'), 0, 10);

      expect(mock_client.api).toHaveBeenCalledWith('https://upload.example/u');
      expect(mock_client.header).toHaveBeenCalledWith('Content-Range', 'bytes 0-1/10');
      expect(mock_client.put).toHaveBeenCalledWith(Buffer.from('ab'));
    });
  });

  describe('add_attachment large file', () => {
    it('uses upload session and chunks for files >= 3 MiB', async () => {
      mock_client.post
        .mockResolvedValueOnce({
          uploadUrl: 'https://upload.example/session',
          expirationDateTime: '2026-03-10T00:00:00Z',
        })
        .mockResolvedValue({});
      mock_client.put.mockResolvedValue({});

      const big = Buffer.alloc(4 * 1024 * 1024, 7);
      await connector.add_attachment('t', 'user@test.com', 'msg-1', {
        name: 'huge.bin',
        content_type: 'application/octet-stream',
        content: big,
        is_inline: false,
      });

      expect(mock_client.post).toHaveBeenCalled();
      expect(mock_client.put.mock.calls.length).toBeGreaterThan(0);
    });
  });

  describe('count_folder_messages', () => {
    it('returns totalItemCount from Graph', async () => {
      mock_client.get.mockResolvedValue({ totalItemCount: 42 });

      const n = await connector.count_folder_messages('t', 'user@test.com', 'folder-1');

      expect(n).toBe(42);
      expect(mock_client.api).toHaveBeenCalledWith(
        '/users/user@test.com/mailFolders/folder-1?$select=totalItemCount',
      );
    });
  });

  describe('list_folder_messages', () => {
    it('maps subjects and defaults missing isDraft to true', async () => {
      mock_client.get.mockResolvedValue({
        value: [
          { subject: 'Hi', isDraft: false },
          { subject: undefined, isDraft: undefined },
        ],
      });

      const rows = await connector.list_folder_messages('t', 'user@test.com', 'folder-1', 2);

      expect(rows).toEqual([
        { subject: 'Hi', is_draft: false },
        { subject: '(no subject)', is_draft: true },
      ]);
    });
  });
});
