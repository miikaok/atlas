/**
 * Orchestrates parallel backup of all licensed mailboxes in a tenant.
 * Always filters to Exchange-licensed mailboxes -- unlicensed ones cause Graph errors.
 * CLI-only -- not wired into the SDK adapter.
 */

import { inject, injectable } from 'inversify';
import type { MailboxDiscoveryService } from '@/ports/mailbox/discovery.port';
import type { BackupUseCase } from '@/ports/backup/use-case.port';
import type {
  TenantBackupOrchestrator as ITenantBackupOrchestrator,
  TenantBackupOptions,
  TenantBackupResult,
  MailboxBackupOutcome,
} from '@/ports/backup/orchestrator.port';
import { MAILBOX_DISCOVERY_TOKEN } from '@/ports/tokens/outgoing.tokens';
import { BACKUP_USE_CASE_TOKEN } from '@/ports/tokens/use-case.tokens';
import { logger } from '@/utils/logger';
import { calc_rate } from '@/services/shared/progress-rate';

const DEFAULT_CONCURRENCY = 4;
const always_false = (): boolean => false;

@injectable()
export class DefaultTenantBackupOrchestrator implements ITenantBackupOrchestrator {
  constructor(
    @inject(MAILBOX_DISCOVERY_TOKEN) private readonly _discovery: MailboxDiscoveryService,
    @inject(BACKUP_USE_CASE_TOKEN) private readonly _backup: BackupUseCase,
  ) {}

  async backup_tenant(
    tenant_id: string,
    options: TenantBackupOptions = {},
  ): Promise<TenantBackupResult> {
    const start = Date.now();
    const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
    const should_interrupt = options.should_interrupt ?? always_false;
    const should_force_stop = options.should_force_stop ?? always_false;
    const progress = options.progress;

    const mailboxes = await this._discovery.list_tenant_mailboxes(tenant_id, {
      licensed_only: true,
    });

    logger.info(`Discovered ${mailboxes.length} mailbox(es) for backup`);
    progress?.set_mailbox_count(mailboxes.length);

    const outcomes: MailboxBackupOutcome[] = [];
    const pending = mailboxes.map((m) => m.mail);
    let done_count = 0;
    let error_count = 0;
    let active_count = 0;
    let global_stored = 0;
    let global_deduped = 0;

    const run_worker = async (slot: number): Promise<void> => {
      while (pending.length > 0 && !should_interrupt()) {
        const mailbox_id = pending.shift()!;
        active_count++;
        progress?.mark_mailbox_active(slot, mailbox_id);

        try {
          const result = await this._backup.sync_mailbox(tenant_id, mailbox_id, {
            force_full: options.force_full,
            page_size: options.page_size,
            should_interrupt,
            should_force_stop,
            create_progress: (folders) => ({
              set_status: () => {},
              mark_active: (idx) => {
                const folder = folders[idx];
                if (folder) {
                  progress?.update_mailbox_progress(slot, folder.name, 0, 0);
                }
              },
              update_active: (_idx, processed, rate) => {
                const total = folders.reduce((s, f) => s + f.total_items, 0);
                const pct = total > 0 ? Math.round((processed / total) * 100) : 0;
                progress?.update_mailbox_progress(slot, '', pct, rate);
              },
              update_paging: (_idx, fetched, rate) => {
                progress?.update_mailbox_progress(slot, 'fetching...', 0, rate);
                void fetched;
              },
              mark_done: () => {},
              mark_all_pending_interrupted: () => {},
              mark_error: () => {},
              update_total: () => {},
              finish: () => {},
            }),
          });

          global_stored += result.summary.stored;
          global_deduped += result.summary.deduplicated;
          done_count++;
          progress?.mark_mailbox_done(
            slot,
            mailbox_id,
            result.summary.stored,
            result.summary.deduplicated,
          );
          outcomes.push({ mailbox_id, result });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          error_count++;
          progress?.mark_mailbox_error(slot, mailbox_id, msg);
          outcomes.push({ mailbox_id, error: msg });
          logger.error(`Mailbox ${mailbox_id} failed: ${msg}`);
        }

        active_count--;
        const elapsed = Date.now() - start;
        const rate = calc_rate(global_stored + global_deduped, elapsed);
        const eta =
          rate > 0
            ? (pending.length * (elapsed / Math.max(done_count + error_count, 1))) / 1000
            : 0;
        progress?.update_totals(done_count, error_count, pending.length, rate, eta);
      }
    };

    const worker_count = Math.min(concurrency, mailboxes.length);
    const workers: Promise<void>[] = [];
    for (let i = 0; i < worker_count; i++) {
      workers.push(run_worker(i));
    }
    await Promise.all(workers);

    progress?.finish();

    return {
      outcomes,
      total_mailboxes: mailboxes.length,
      succeeded: done_count,
      failed: error_count,
      interrupted: should_interrupt(),
      elapsed_ms: Date.now() - start,
    };
  }
}
