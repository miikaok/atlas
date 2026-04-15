import { describe, it, expect, vi } from 'vitest';
import { create_mailbox_progress_adapter } from '@/services/backup/tenant-backup-progress-adapter';
import type { TenantProgressReporter } from '@/ports/backup/tenant-progress.port';

function make_tenant_mock(update: ReturnType<typeof vi.fn>): TenantProgressReporter {
  return {
    set_mailbox_count: vi.fn(),
    mark_mailbox_active: vi.fn(),
    update_mailbox_progress: update,
    mark_mailbox_done: vi.fn(),
    mark_mailbox_error: vi.fn(),
    update_totals: vi.fn(),
    set_status: vi.fn(),
    finish: vi.fn(),
  };
}

describe('create_mailbox_progress_adapter', () => {
  it('forwards percent and rate to tenant progress', () => {
    const update = vi.fn();
    const tenant = make_tenant_mock(update);

    const factory = create_mailbox_progress_adapter(2, tenant);
    const reporter = factory([{ name: 'Inbox', total_items: 100 }]);

    reporter.mark_active(0);
    reporter.update_active(0, 50, 2.5, 10);

    expect(update).toHaveBeenCalledWith(2, 'Inbox', 0, 0);
    expect(update).toHaveBeenCalledWith(2, '', 50, 2.5);
  });

  it('update_paging sends fetching label', () => {
    const update = vi.fn();
    const tenant = make_tenant_mock(update);
    const reporter = create_mailbox_progress_adapter(0, tenant)([{ name: 'A', total_items: 1 }]);
    reporter.update_paging(0, 5, 1.2, 0);
    expect(update).toHaveBeenCalledWith(0, 'fetching...', 0, 1.2);
  });

  it('works when tenant_progress is undefined', () => {
    const factory = create_mailbox_progress_adapter(0, undefined);
    const reporter = factory([{ name: 'A', total_items: 10 }]);
    expect(() => reporter.mark_active(0)).not.toThrow();
    expect(() => reporter.update_active(0, 1, 1, 0)).not.toThrow();
  });
});
