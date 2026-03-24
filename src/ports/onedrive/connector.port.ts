export interface OneDriveDrive {
  readonly drive_id: string;
  readonly drive_name: string;
}

export type OneDriveDeltaItemKind = 'file' | 'folder';

export interface OneDriveDeltaItem {
  readonly item_id: string;
  readonly drive_id: string;
  readonly kind: OneDriveDeltaItemKind;
  readonly file_name: string;
  readonly parent_path: string;
  readonly web_url?: string;
  readonly size_bytes: number;
  readonly etag?: string;
  readonly last_modified_at?: string;
  readonly deleted: boolean;
  readonly download_url?: string;
}

export interface OneDriveDeltaResult {
  readonly drive_id: string;
  readonly delta_link: string;
  readonly items: OneDriveDeltaItem[];
  readonly reset_detected: boolean;
}

export interface OneDriveConnector {
  list_drives(tenant_id: string, owner_id: string): Promise<OneDriveDrive[]>;
  fetch_delta(
    tenant_id: string,
    owner_id: string,
    drive_id: string,
    prev_delta_link?: string,
  ): Promise<OneDriveDeltaResult>;
  download_file_content(item: OneDriveDeltaItem): Promise<Buffer>;
}
