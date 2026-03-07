export interface MailFolder {
  readonly folder_id: string;
  readonly display_name: string;
  readonly parent_folder_id?: string | undefined;
  readonly total_item_count: number;
}

export interface MailMessage {
  readonly message_id: string;
  readonly folder_id: string;
  readonly subject: string;
  readonly received_at: Date;
  readonly size_bytes: number;
  readonly raw_body: Buffer;
}

export interface DeltaSyncResult {
  readonly messages: MailMessage[];
  /** IDs of messages deleted or moved out of this folder since the last sync. */
  readonly removed_ids: string[];
  /** Full @odata.deltaLink URL to pass to the next sync call. */
  readonly delta_link: string;
  /** True when the previous delta link was invalid and a full re-enumeration occurred. */
  readonly delta_reset: boolean;
}

/** Called after each delta page to report enumeration progress. */
export type DeltaPageCallback = (page_num: number, items_so_far: number) => void;

export interface MailboxConnector {
  list_mailboxes(tenant_id: string): Promise<string[]>;

  list_mail_folders(tenant_id: string, mailbox_id: string): Promise<MailFolder[]>;

  /**
   * Fetches messages changed since the previous delta link.
   * Pass the full @odata.deltaLink URL from a prior sync, or omit for a full initial sync.
   * The optional on_page callback is invoked after each page for progress reporting.
   */
  fetch_delta(
    tenant_id: string,
    mailbox_id: string,
    folder_id: string,
    prev_delta_link?: string | undefined,
    on_page?: DeltaPageCallback | undefined,
  ): Promise<DeltaSyncResult>;

  fetch_message(tenant_id: string, mailbox_id: string, message_id: string): Promise<MailMessage>;
}

export const MAILBOX_CONNECTOR_TOKEN = Symbol.for('MailboxConnector');
