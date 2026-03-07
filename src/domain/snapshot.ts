export interface Snapshot {
  readonly id: string;
  readonly tenant_id: string;
  readonly mailbox_id: string;
  readonly started_at: Date;
  readonly completed_at?: Date;
  readonly object_count: number;
  readonly status: SnapshotStatus;
}

export enum SnapshotStatus {
  IN_PROGRESS = 'IN_PROGRESS',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
}
