import { randomUUID } from 'node:crypto';
import type { Snapshot } from '@/domain/snapshot';
import { SnapshotStatus } from '@/domain/snapshot';
import type { Manifest, ManifestEntry, ManifestObjectLockPolicy } from '@/domain/manifest';

/** Creates a snapshot record in IN_PROGRESS state. */
export function create_pending_snapshot(tenant_id: string, mailbox_id: string): Snapshot {
  return {
    id: randomUUID(),
    tenant_id,
    mailbox_id,
    started_at: new Date(),
    object_count: 0,
    status: SnapshotStatus.IN_PROGRESS,
  };
}

/** Returns a copy of the snapshot marked as COMPLETED with final counts. */
export function mark_snapshot_completed(snapshot: Snapshot, object_count: number): Snapshot {
  return {
    ...snapshot,
    completed_at: new Date(),
    object_count,
    status: SnapshotStatus.COMPLETED,
  };
}

/**
 * Assembles a complete manifest. When the current sync found no new entries,
 * carries forward the prior backup's total_objects so the stale-delta
 * safeguard does not mistake an unchanged mailbox for a never-backed-up one.
 */
export function build_manifest(
  mailbox_id: string,
  snapshot_id: string,
  entries: ManifestEntry[],
  delta_links: Record<string, string>,
  previous_total_objects = 0,
  object_lock?: ManifestObjectLockPolicy,
): Manifest {
  const total_size_bytes = entries.reduce((sum, e) => {
    const att_size = e.attachments?.reduce((a, att) => a + att.size_bytes, 0) ?? 0;
    return sum + e.size_bytes + att_size;
  }, 0);
  return {
    id: randomUUID(),
    tenant_id: '',
    mailbox_id,
    snapshot_id,
    created_at: new Date(),
    total_objects: Math.max(entries.length, previous_total_objects),
    total_size_bytes,
    delta_links,
    object_lock,
    entries,
  };
}
