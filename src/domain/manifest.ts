export interface Manifest {
  readonly id: string;
  readonly tenant_id: string;
  readonly mailbox_id: string;
  readonly snapshot_id: string;
  readonly created_at: Date;
  readonly total_objects: number;
  readonly total_size_bytes: number;
  /** Maps folder_id -> full @odata.deltaLink URL for the next incremental sync. */
  readonly delta_links: Record<string, string>;
  readonly entries: ManifestEntry[];
}

export interface AttachmentEntry {
  readonly attachment_id: string;
  readonly name: string;
  readonly content_type: string;
  readonly size_bytes: number;
  readonly storage_key: string;
  readonly checksum: string;
  readonly is_inline: boolean;
}

export interface ManifestEntry {
  readonly object_id: string;
  readonly storage_key: string;
  readonly checksum: string;
  readonly size_bytes: number;
  readonly subject?: string;
  readonly attachments?: AttachmentEntry[];
}
