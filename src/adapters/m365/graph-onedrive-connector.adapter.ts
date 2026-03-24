import { inject, injectable } from 'inversify';
import type { Client } from '@microsoft/microsoft-graph-client';
import { GRAPH_CLIENT_TOKEN } from '@/adapters/m365/graph-client.factory';
import type {
  OneDriveConnector,
  OneDriveDeltaItem,
  OneDriveDeltaResult,
  OneDriveDrive,
} from '@/ports/onedrive/connector.port';
import { is_invalid_delta_error, with_graph_retry } from '@/adapters/m365/graph-error-helpers';

interface GraphCollectionResponse<T> {
  value?: T[];
  '@odata.nextLink'?: string;
  '@odata.deltaLink'?: string;
}

interface GraphDriveRecord {
  id?: string;
  name?: string;
}

interface GraphParentReference {
  path?: string;
}

interface GraphDeltaDriveItem {
  id?: string;
  name?: string;
  size?: number;
  webUrl?: string;
  eTag?: string;
  lastModifiedDateTime?: string;
  parentReference?: GraphParentReference;
  file?: Record<string, unknown>;
  folder?: Record<string, unknown>;
  '@removed'?: { reason: string };
  '@microsoft.graph.downloadUrl'?: string;
}

interface GraphDriveItemDownload {
  '@microsoft.graph.downloadUrl'?: string;
}

const DRIVE_DELTA_SELECT_FIELDS = [
  'id',
  'name',
  'size',
  'webUrl',
  'eTag',
  'lastModifiedDateTime',
  'parentReference',
  'file',
  'folder',
  '@microsoft.graph.downloadUrl',
].join(',');

@injectable()
export class GraphOneDriveConnector implements OneDriveConnector {
  constructor(@inject(GRAPH_CLIENT_TOKEN) private readonly _client: Client) {}

  async list_drives(_tenant_id: string, owner_id: string): Promise<OneDriveDrive[]> {
    try {
      const response = await with_graph_retry(
        () =>
          this._client.api(`/users/${owner_id}/drives?$select=id,name`).get() as Promise<
            GraphCollectionResponse<GraphDriveRecord>
          >,
      );
      const drives = (response.value ?? [])
        .filter((drive) => Boolean(drive.id))
        .map((drive) => ({
          drive_id: drive.id ?? '',
          drive_name: drive.name ?? '',
        }));
      if (drives.length > 0) return drives;

      let default_drive: GraphDriveRecord | undefined;
      try {
        default_drive = await with_graph_retry(
          () =>
            this._client
              .api(`/users/${owner_id}/drive?$select=id,name`)
              .get() as Promise<GraphDriveRecord>,
        );
      } catch (err) {
        const status = (err as Record<string, unknown>).statusCode;
        if (status === 404) throw_missing_onedrive_permissions();
        throw err;
      }
      if (!default_drive.id) throw_missing_onedrive_permissions();
      return [
        {
          drive_id: default_drive.id,
          drive_name: default_drive.name ?? 'default',
        },
      ];
    } catch (err) {
      rethrow_if_onedrive_access_denied(err);
      throw err;
    }
  }

  async fetch_delta(
    _tenant_id: string,
    owner_id: string,
    drive_id: string,
    prev_delta_link?: string,
  ): Promise<OneDriveDeltaResult> {
    try {
      return await this.execute_delta(owner_id, drive_id, prev_delta_link, false);
    } catch (err) {
      rethrow_if_onedrive_access_denied(err);
      if (is_invalid_delta_error(err)) {
        return await this.execute_delta(owner_id, drive_id, undefined, true);
      }
      throw err;
    }
  }

  async download_file_content(item: OneDriveDeltaItem): Promise<Buffer> {
    const initial_download_url = item.download_url ?? (await this.resolve_download_url(item));
    if (initial_download_url) {
      try {
        return await download_from_url(initial_download_url, item.item_id);
      } catch {
        return await this.download_via_graph_content(item);
      }
    }

    return await this.download_via_graph_content(item);
  }

  private async resolve_download_url(item: OneDriveDeltaItem): Promise<string | undefined> {
    const response = await with_graph_retry(
      () =>
        this._client
          .api(`/drives/${item.drive_id}/items/${item.item_id}`)
          .select('@microsoft.graph.downloadUrl')
          .get() as Promise<GraphDriveItemDownload>,
    );
    return response['@microsoft.graph.downloadUrl'];
  }

  private async download_via_graph_content(item: OneDriveDeltaItem): Promise<Buffer> {
    const stream = await with_timeout(
      with_graph_retry(
        () =>
          this._client
            .api(`/drives/${item.drive_id}/items/${item.item_id}/content`)
            .getStream() as Promise<NodeJS.ReadableStream>,
      ),
      45_000,
      `Graph content request timed out for file ${item.item_id}`,
    );
    return await stream_to_buffer(stream);
  }

  private async execute_delta(
    owner_id: string,
    drive_id: string,
    prev_delta_link: string | undefined,
    reset_detected: boolean,
  ): Promise<OneDriveDeltaResult> {
    const items: OneDriveDeltaItem[] = [];
    let page: GraphCollectionResponse<GraphDeltaDriveItem>;
    let delta_link = '';

    if (prev_delta_link) {
      page = await with_graph_retry(
        () =>
          this._client.api(prev_delta_link).get() as Promise<
            GraphCollectionResponse<GraphDeltaDriveItem>
          >,
      );
    } else {
      page = await with_graph_retry(
        () =>
          this._client
            .api(`/users/${owner_id}/drives/${drive_id}/root/delta`)
            .select(DRIVE_DELTA_SELECT_FIELDS)
            .get() as Promise<GraphCollectionResponse<GraphDeltaDriveItem>>,
      );
    }

    while (true) {
      for (const raw of page.value ?? []) {
        if (!raw.id) continue;
        const parent_path = this.extract_parent_path(raw.parentReference?.path);
        const kind: 'file' | 'folder' = raw.file ? 'file' : 'folder';
        const item: OneDriveDeltaItem = {
          item_id: raw.id,
          drive_id,
          kind,
          file_name: raw.name ?? '',
          parent_path,
          size_bytes: raw.size ?? 0,
          deleted: Boolean(raw['@removed']),
          ...(raw.webUrl ? { web_url: raw.webUrl } : {}),
          ...(raw.eTag ? { etag: raw.eTag } : {}),
          ...(raw.lastModifiedDateTime ? { last_modified_at: raw.lastModifiedDateTime } : {}),
          ...(raw['@microsoft.graph.downloadUrl']
            ? { download_url: raw['@microsoft.graph.downloadUrl'] }
            : {}),
        };
        items.push(item);
      }

      if (page['@odata.deltaLink']) {
        delta_link = page['@odata.deltaLink'];
      }

      const next = page['@odata.nextLink'];
      if (!next) break;
      page = await with_graph_retry(
        () => this._client.api(next).get() as Promise<GraphCollectionResponse<GraphDeltaDriveItem>>,
      );
    }

    return {
      drive_id,
      delta_link,
      items,
      reset_detected,
    };
  }

  private extract_parent_path(raw_path: string | undefined): string {
    if (!raw_path) return '/';
    const marker = 'root:';
    const marker_index = raw_path.indexOf(marker);
    if (marker_index < 0) return raw_path;
    const result = raw_path.slice(marker_index + marker.length);
    return result.length === 0 ? '/' : result;
  }
}

function rethrow_if_onedrive_access_denied(err: unknown): void {
  const graph_err = err as Record<string, unknown>;
  if (graph_err.statusCode !== 403) return;
  throw_missing_onedrive_permissions();
}

function throw_missing_onedrive_permissions(): never {
  throw new Error(
    'Missing Microsoft Graph application permissions for OneDrive: Files.Read.All, Sites.Read.All.',
  );
}

async function download_from_url(download_url: string, item_id: string): Promise<Buffer> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45_000);
  try {
    const response = await fetch(download_url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`Failed to download OneDrive file ${item_id}: HTTP ${response.status}`);
    }
    const bytes = await response.arrayBuffer();
    return Buffer.from(bytes);
  } finally {
    clearTimeout(timeout);
  }
}

async function stream_to_buffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const read_stream = async (): Promise<void> => {
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
  };
  await with_timeout(read_stream(), 90_000, 'Graph content stream timed out');
  return Buffer.concat(chunks);
}

async function with_timeout<T>(
  promise: Promise<T>,
  timeout_ms: number,
  message: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeout_ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
