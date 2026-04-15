import { describe, it, expect, vi } from 'vitest';
import {
  group_entries_by_folder,
  filter_entries_by_folder_name,
  count_unique_folders,
  ensure_subfolder,
  build_folder_map,
} from '@/services/restore/folder-restore-planner';
import type { ManifestEntry } from '@/domain/manifest';
import type { RestoreConnector } from '@/ports/restore/connector.port';
import type { MailboxConnector } from '@/ports/mailbox/connector.port';

function entry(oid: string, folder_id?: string): ManifestEntry {
  return {
    object_id: oid,
    storage_key: `data/m/${oid}`,
    checksum: 'abc',
    size_bytes: 1,
    folder_id,
  };
}

describe('folder-restore-planner', () => {
  describe('group_entries_by_folder', () => {
    it('groups by folder_id and uses __unknown__ when missing', () => {
      const g = group_entries_by_folder([entry('a', 'f1'), entry('b'), entry('c', 'f1')]);
      expect(g.get('f1')?.map((e) => e.object_id)).toEqual(['a', 'c']);
      expect(g.get('__unknown__')?.map((e) => e.object_id)).toEqual(['b']);
    });
  });

  describe('count_unique_folders', () => {
    it('counts distinct folder ids including unknown bucket', () => {
      expect(count_unique_folders([entry('1', 'a'), entry('2', 'a'), entry('3')])).toBe(2);
    });
  });

  describe('filter_entries_by_folder_name', () => {
    it('filters by folder display name', () => {
      const folder_map = new Map([
        ['fid-inbox', 'Inbox'],
        ['fid-sent', 'Sent'],
      ]);
      const entries = [entry('1', 'fid-inbox'), entry('2', 'fid-sent')];
      const r = filter_entries_by_folder_name(entries, 'inbox', folder_map);
      expect(r.map((e) => e.object_id)).toEqual(['1']);
    });

    it('returns empty when name not found', () => {
      const folder_map = new Map([['x', 'Only']]);
      expect(filter_entries_by_folder_name([entry('1', 'x')], 'missing', folder_map)).toEqual([]);
    });
  });

  describe('ensure_subfolder', () => {
    it('returns cached folder id on second call', async () => {
      const restore_connector: RestoreConnector = {
        create_mail_folder: vi.fn().mockResolvedValue({ folder_id: 'new-f', display_name: 'X' }),
      } as unknown as RestoreConnector;

      const folder_map = new Map([['orig', 'Sub']]);
      const created = new Map<string, string>();

      const a = await ensure_subfolder(
        restore_connector,
        't',
        'm',
        'root',
        'orig',
        folder_map,
        created,
      );
      const b = await ensure_subfolder(
        restore_connector,
        't',
        'm',
        'root',
        'orig',
        folder_map,
        created,
      );

      expect(a).toBe('new-f');
      expect(b).toBe('new-f');
      expect(restore_connector.create_mail_folder).toHaveBeenCalledTimes(1);
    });
  });

  describe('build_folder_map', () => {
    it('maps folder ids to display names', async () => {
      const connector: MailboxConnector = {
        list_mail_folders: vi.fn().mockResolvedValue([
          { folder_id: 'a', display_name: 'Inbox' },
          { folder_id: 'b', display_name: 'Sent' },
        ]),
      } as unknown as MailboxConnector;

      const map = await build_folder_map(connector, 't', 'm');
      expect(map.get('a')).toBe('Inbox');
      expect(map.get('b')).toBe('Sent');
    });
  });
});
