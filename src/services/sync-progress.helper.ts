import { logger } from '@/utils/logger';

export interface FolderProgress {
  folder_name: string;
  folder_index: number;
  folder_count: number;
  folder_total_items: number;
  folder_processed: number;
  global_total_items: number;
  global_processed: number;
  started_at: number;
  folder_started_at: number;
  /** Transient suffix for attachment sub-progress, e.g. "att 3/5". */
  att_suffix: string;
}

/** Overwrites the terminal line with rate and ETA for the current folder. */
export function emit_progress(p: FolderProgress, label: string): void {
  const now = Date.now();
  const rate = calc_rate(p.global_processed, now - p.started_at);
  const eta = rate > 0 ? (p.global_total_items - p.global_processed) / rate : 0;

  logger.progress(
    `${label} ${p.folder_processed}/${p.folder_total_items}` +
      ` | ${rate.toFixed(1)} msg/s` +
      ` | ETA ${format_duration(eta)}` +
      p.att_suffix,
  );
}

/**
 * Progress line during delta paging. Shows items fetched so far vs folder total
 * and extrapolates an ETA based on the paging rate.
 */
export function emit_paging_progress(
  p: FolderProgress,
  label: string,
  items_fetched: number,
): void {
  const elapsed_ms = Date.now() - p.folder_started_at;
  const page_rate = calc_rate(items_fetched, elapsed_ms);
  const remaining_items = p.global_total_items - p.global_processed - items_fetched;
  const eta = page_rate > 0 ? remaining_items / page_rate : 0;

  logger.progress(
    `${label} fetching ${items_fetched}/${p.folder_total_items}` +
      ` | ${page_rate.toFixed(1)} items/s` +
      ` | ETA ${format_duration(eta)}`,
  );
}

/** Messages processed per second based on wall-clock elapsed time. */
export function calc_rate(processed: number, elapsed_ms: number): number {
  const s = elapsed_ms / 1000;
  return s > 0 ? processed / s : 0;
}

/** Formats seconds into a human-readable duration string. */
export function format_duration(seconds: number): string {
  if (!isFinite(seconds) || seconds <= 0) return '--';
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}
