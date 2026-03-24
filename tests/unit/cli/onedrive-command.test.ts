import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Container } from 'inversify';
import { Command } from 'commander';
import { register_onedrive_commands } from '@/cli/commands/onedrive.command';
import { ATLAS_CONFIG_TOKEN } from '@/utils/config';
import {
  ONEDRIVE_BACKUP_USE_CASE_TOKEN,
  ONEDRIVE_CATALOG_USE_CASE_TOKEN,
  ONEDRIVE_VERIFICATION_USE_CASE_TOKEN,
} from '@/ports/tokens/use-case.tokens';

describe('onedrive.command', () => {
  let container: Container;
  let program: Command;
  const backup_onedrive = vi.fn();
  const list_onedrive_snapshots = vi.fn();
  const list_onedrive_file_versions = vi.fn();
  const verify_onedrive_snapshot = vi.fn();

  beforeEach(() => {
    container = new Container();
    container.bind(ATLAS_CONFIG_TOKEN).toConstantValue({ tenant_id: 'tenant-from-config' });
    container.bind(ONEDRIVE_BACKUP_USE_CASE_TOKEN).toConstantValue({ backup_onedrive });
    container.bind(ONEDRIVE_CATALOG_USE_CASE_TOKEN).toConstantValue({
      list_onedrive_snapshots,
      list_onedrive_file_versions,
    });
    container.bind(ONEDRIVE_VERIFICATION_USE_CASE_TOKEN).toConstantValue({
      verify_onedrive_snapshot,
    });

    backup_onedrive.mockReset().mockResolvedValue({
      owner_id: 'owner@test.com',
      snapshot: undefined,
      summary: {
        drives_scanned: 1,
        files_changed: 0,
        files_stored: 0,
        files_deduplicated: 0,
        deleted_items: 0,
        cursor_updated: true,
        snapshot_created: false,
      },
    });
    list_onedrive_snapshots.mockReset().mockResolvedValue([]);
    list_onedrive_file_versions.mockReset().mockResolvedValue([]);
    verify_onedrive_snapshot.mockReset().mockResolvedValue({
      snapshot_id: 'snap-1',
      total_checked: 0,
      passed: 0,
      failed_file_ids: [],
      index_issues: [],
    });

    program = new Command();
    register_onedrive_commands(program, () => container);
  });

  it('delegates onedrive backup to use case with tenant from config', async () => {
    await program.parseAsync(['onedrive', 'backup', '--owner', 'owner@test.com', '--full'], {
      from: 'user',
    });
    expect(backup_onedrive).toHaveBeenCalledWith('tenant-from-config', 'owner@test.com', {
      force_full: true,
    });
  });

  it('delegates list versions to OneDriveCatalogUseCase', async () => {
    await program.parseAsync(
      ['onedrive', 'list-versions', '--owner', 'owner@test.com', '--file', '/docs/a.txt'],
      { from: 'user' },
    );
    expect(list_onedrive_file_versions).toHaveBeenCalledWith(
      'tenant-from-config',
      'owner@test.com',
      '/docs/a.txt',
    );
  });

  it('delegates verify to OneDriveVerificationUseCase', async () => {
    await program.parseAsync(['onedrive', 'verify', '--snapshot', 'snap-1'], { from: 'user' });
    expect(verify_onedrive_snapshot).toHaveBeenCalledWith('tenant-from-config', 'snap-1');
  });
});
