import { inject, injectable } from 'inversify';
import type { Client } from '@microsoft/microsoft-graph-client';
import { GRAPH_CLIENT_TOKEN } from '@/adapters/m365/graph-client.factory';
import type {
  MailboxConnector,
  MailFolder,
  MailMessage,
  DeltaSyncResult,
  DeltaPageCallback,
} from '@/ports/mailbox-connector.port';
import { logger } from '@/utils/logger';

const EXCLUDED_FOLDERS = new Set(['drafts', 'outbox', 'recoverableitemsdeletions', 'junkemail']);


/**
 * Fields to request from the delta endpoint so each page contains
 * the full message body, eliminating the need for per-message fetches.
 */
const DELTA_SELECT_FIELDS = [
  'id',
  'subject',
  'body',
  'bodyPreview',
  'from',
  'sender',
  'toRecipients',
  'ccRecipients',
  'bccRecipients',
  'replyTo',
  'receivedDateTime',
  'sentDateTime',
  'createdDateTime',
  'lastModifiedDateTime',
  'parentFolderId',
  'importance',
  'isRead',
  'isDraft',
  'hasAttachments',
  'internetMessageId',
  'conversationId',
  'flag',
  'categories',
].join(',');

interface GraphPageResponse {
  value?: GraphUserRecord[] | GraphFolderRecord[] | GraphDeltaMessage[];
  '@odata.nextLink'?: string;
  '@odata.deltaLink'?: string;
}

interface GraphUserRecord {
  id?: string;
  mail?: string;
  displayName?: string;
}

interface GraphFolderRecord {
  id?: string;
  displayName?: string;
  parentFolderId?: string;
  totalItemCount?: number;
}

interface GraphDeltaMessage {
  id?: string;
  subject?: string;
  body?: { contentType?: string; content?: string };
  receivedDateTime?: string;
  parentFolderId?: string;
  '@removed'?: { reason: string };
  [key: string]: unknown;
}

@injectable()
export class GraphMailboxConnector implements MailboxConnector {
  constructor(@inject(GRAPH_CLIENT_TOKEN) private readonly _client: Client) {}

  /**
   * Lists all user mailbox IDs in the tenant by paging through the /users endpoint.
   * Only returns users that have a mail address set.
   */
  async list_mailboxes(_tenant_id: string): Promise<string[]> {
    try {
      const url = '/users?$select=id,mail,displayName&$filter=mail ne null&$top=999';
      const user_records = await this.collect_all_pages<GraphUserRecord>(url);
      return this.extract_user_ids(user_records);
    } catch (err) {
      this.rethrow_if_access_denied(err);
      throw err;
    }
  }

  /**
   * Lists all mail folders for a mailbox, excluding system folders
   * (drafts, outbox, junk, recoverable items).
   */
  async list_mail_folders(_tenant_id: string, mailbox_id: string): Promise<MailFolder[]> {
    try {
      const url =
        `/users/${mailbox_id}/mailFolders` +
        '?$select=id,displayName,parentFolderId,totalItemCount&$top=250';
      const folder_records = await this.collect_all_pages<GraphFolderRecord>(url);
      return this.filter_and_map_folders(folder_records);
    } catch (err) {
      this.rethrow_if_access_denied(err);
      throw err;
    }
  }

  /**
   * Fetches messages changed since the previous delta link for one folder.
   * If prev_delta_link is provided, resumes from that point.
   * Falls back to full enumeration when Graph reports an invalid delta state.
   */
  async fetch_delta(
    _tenant_id: string,
    mailbox_id: string,
    folder_id: string,
    prev_delta_link?: string,
    on_page?: DeltaPageCallback,
  ): Promise<DeltaSyncResult> {
    logger.debug(
      prev_delta_link
        ? `fetch_delta: resuming from saved delta link`
        : `fetch_delta: starting initial full sync`,
    );

    try {
      return await this.execute_delta_sync(mailbox_id, folder_id, prev_delta_link, false, on_page);
    } catch (err) {
      this.rethrow_if_access_denied(err);
      if (this.is_invalid_delta_error(err)) {
        logger.debug('fetch_delta: invalid delta token, falling back to full sync');
        return await this.execute_delta_sync(mailbox_id, folder_id, undefined, true, on_page);
      }
      throw err;
    }
  }

  /** Fetches a single message by ID, returning its full JSON body as a Buffer. */
  async fetch_message(
    _tenant_id: string,
    mailbox_id: string,
    message_id: string,
  ): Promise<MailMessage> {
    try {
      const response = (await this._client
        .api(`/users/${mailbox_id}/messages/${message_id}`)
        .get()) as GraphDeltaMessage;

      return this.graph_message_to_mail_message(response);
    } catch (err) {
      this.rethrow_if_access_denied(err);
      throw err;
    }
  }

  // ---------------------------------------------------------------------------
  // Delta sync internals
  // ---------------------------------------------------------------------------

  /** Returns the delta endpoint path for a mailbox folder (no query params). */
  private delta_path(mailbox_id: string, folder_id: string): string {
    return `/users/${mailbox_id}/mailFolders/${folder_id}/messages/delta`;
  }

  /**
   * Fetches the first page of an initial delta request using the SDK fluent API.
   * No $top is set -- the API decides page size (typically smaller when body
   * is selected) and pages through ALL items via @odata.nextLink.
   * Setting $top can cap total results across pages, not just per-page.
   */
  private async fetch_initial_delta_page(
    mailbox_id: string,
    folder_id: string,
  ): Promise<GraphPageResponse> {
    return (await this._client
      .api(this.delta_path(mailbox_id, folder_id))
      .select(DELTA_SELECT_FIELDS)
      .get()) as GraphPageResponse;
  }

  /**
   * Fetches a page using a full @odata.nextLink or @odata.deltaLink URL.
   * These URLs already carry their own query parameters.
   */
  private async fetch_continuation_page(full_url: string): Promise<GraphPageResponse> {
    return (await this._client.api(full_url).get()) as GraphPageResponse;
  }

  /**
   * Runs a complete delta sync for a folder. Pages through all results,
   * directly converting each message to a MailMessage (body included in
   * the delta response, so no per-message fetches are needed).
   */
  private async execute_delta_sync(
    mailbox_id: string,
    folder_id: string,
    prev_delta_link: string | undefined,
    delta_reset: boolean,
    on_page?: DeltaPageCallback,
  ): Promise<DeltaSyncResult> {
    const is_initial = !prev_delta_link;
    const messages: MailMessage[] = [];
    const removed_ids: string[] = [];
    let delta_link = '';
    let page_count = 0;

    let page: GraphPageResponse = is_initial
      ? await this.fetch_initial_delta_page(mailbox_id, folder_id)
      : await this.fetch_continuation_page(prev_delta_link);

    while (true) {
      page_count++;
      const items = (page.value ?? []) as GraphDeltaMessage[];

      for (const item of items) {
        if (item['@removed'] && item.id) {
          removed_ids.push(item.id);
        } else if (item.id) {
          messages.push(this.graph_message_to_mail_message(item));
        }
      }

      on_page?.(page_count, messages.length);

      if (page['@odata.deltaLink']) {
        delta_link = page['@odata.deltaLink'];
      }

      const next_url = page['@odata.nextLink'];
      if (!next_url) break;

      page = await this.fetch_continuation_page(next_url);
    }

    return { messages, removed_ids, delta_link, delta_reset };
  }

  /** Converts a raw Graph message response into our MailMessage domain type. */
  private graph_message_to_mail_message(msg: GraphDeltaMessage): MailMessage {
    const body_buffer = Buffer.from(JSON.stringify(msg));
    return {
      message_id: msg.id ?? '',
      folder_id: (msg.parentFolderId as string) ?? '',
      subject: (msg.subject as string) ?? '',
      received_at: msg.receivedDateTime ? new Date(msg.receivedDateTime) : new Date(),
      size_bytes: body_buffer.length,
      raw_body: body_buffer,
    };
  }

  // ---------------------------------------------------------------------------
  // Pagination helpers
  // ---------------------------------------------------------------------------

  /** Generic paginator that follows @odata.nextLink and collects all items. */
  private async collect_all_pages<T>(start_url: string): Promise<T[]> {
    const all_items: T[] = [];
    let current_url: string | undefined = start_url;

    while (current_url) {
      const page = await this.fetch_continuation_page(current_url);
      if (page.value) {
        all_items.push(...(page.value as T[]));
      }
      current_url = page['@odata.nextLink'];
    }

    return all_items;
  }

  /** Extracts non-null user IDs from Graph user records. */
  private extract_user_ids(users: GraphUserRecord[]): string[] {
    return users.filter((u) => u.id).map((u) => u.id!);
  }

  /** Filters out excluded system folders and maps to our MailFolder type. */
  private filter_and_map_folders(folders: GraphFolderRecord[]): MailFolder[] {
    return folders
      .filter((f) => f.id && !EXCLUDED_FOLDERS.has((f.displayName ?? '').toLowerCase()))
      .map((f) => ({
        folder_id: f.id!,
        display_name: f.displayName ?? '',
        parent_folder_id: f.parentFolderId ?? undefined,
        total_item_count: f.totalItemCount ?? 0,
      }));
  }

  // ---------------------------------------------------------------------------
  // Error classification
  // ---------------------------------------------------------------------------

  /**
   * Detects Graph errors that indicate an invalid/expired delta token.
   * Matches Corso's pattern: syncStateNotFound, resyncRequired, syncStateInvalid.
   */
  private is_invalid_delta_error(err: unknown): boolean {
    const message = err instanceof Error ? err.message : String(err);
    const lower = message.toLowerCase();
    return (
      lower.includes('syncstatenotfound') ||
      lower.includes('resyncrequired') ||
      lower.includes('syncstateinvalid')
    );
  }

  /**
   * Detects 403 ErrorAccessDenied from Graph and rethrows with
   * actionable guidance about which API permissions to grant.
   */
  private rethrow_if_access_denied(err: unknown): void {
    const graph_err = err as Record<string, unknown>;
    if (graph_err.statusCode !== 403) return;

    const required = [
      'Mail.Read              – read mailbox messages',
      'Mail.ReadWrite         – delta sync and full message fetch',
      'User.Read.All          – list tenant users / mailboxes',
      'MailboxSettings.Read   – enumerate mail folders',
    ];

    const hint =
      `Microsoft Graph returned 403 Forbidden (ErrorAccessDenied).\n` +
      `The app registration needs these Application permissions with admin consent:\n\n` +
      required.map((p) => `  • ${p}`).join('\n') +
      `\n\n` +
      `Grant them in Azure Portal → App registrations → API permissions → ` +
      `Add a permission → Microsoft Graph → Application permissions, ` +
      `then click "Grant admin consent".`;

    throw new Error(hint);
  }
}
