export const ONEDRIVE_DATA_PREFIX = 'onedrive/data';
export const ONEDRIVE_MANIFEST_PREFIX = 'onedrive/manifests';
export const ONEDRIVE_INDEX_PREFIX = 'onedrive/index';
export const ONEDRIVE_META_PREFIX = 'onedrive/_meta';

export function onedrive_data_key(owner_id: string, checksum: string): string {
  return `${ONEDRIVE_DATA_PREFIX}/${owner_id}/${checksum}`;
}

export function onedrive_manifest_key(owner_id: string, snapshot_id: string): string {
  return `${ONEDRIVE_MANIFEST_PREFIX}/${owner_id}/${snapshot_id}.json`;
}

export function onedrive_manifest_prefix(owner_id: string): string {
  return `${ONEDRIVE_MANIFEST_PREFIX}/${owner_id}/`;
}

export function onedrive_manifest_root_prefix(): string {
  return `${ONEDRIVE_MANIFEST_PREFIX}/`;
}

export function onedrive_index_key(owner_id: string, file_id: string): string {
  return `${ONEDRIVE_INDEX_PREFIX}/${owner_id}/files/${file_id}.json`;
}

export function onedrive_index_prefix(owner_id: string): string {
  return `${ONEDRIVE_INDEX_PREFIX}/${owner_id}/files/`;
}

export function onedrive_index_root_prefix(): string {
  return `${ONEDRIVE_INDEX_PREFIX}/`;
}

export function onedrive_delta_cursor_key(owner_id: string): string {
  return `${ONEDRIVE_META_PREFIX}/${owner_id}/delta.json`;
}
