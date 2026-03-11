const RETRYABLE_STATUS_CODES = new Set([429, 503, 504]);
const MAX_RETRIES = 4;
const BASE_DELAY_MS = 1000;

/**
 * Detects Graph errors that indicate an invalid/expired delta token.
 * Matches Corso's pattern: syncStateNotFound, resyncRequired, syncStateInvalid.
 */
export function is_invalid_delta_error(err: unknown): boolean {
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
export function rethrow_if_access_denied(err: unknown): void {
  const graph_err = err as Record<string, unknown>;
  if (graph_err.statusCode !== 403) return;

  const required = [
    'Mail.Read              -- read mailbox messages',
    'Mail.ReadWrite         -- delta sync and full message fetch',
    'User.Read.All          -- list tenant users / mailboxes',
    'MailboxSettings.Read   -- enumerate mail folders',
  ];

  const hint =
    `Microsoft Graph returned 403 Forbidden (ErrorAccessDenied).\n` +
    `The app registration needs these Application permissions with admin consent:\n\n` +
    required.map((p) => `  - ${p}`).join('\n') +
    `\n\n` +
    `Grant them in Azure Portal > App registrations > API permissions > ` +
    `Add a permission > Microsoft Graph > Application permissions, ` +
    `then click "Grant admin consent".`;

  throw new Error(hint);
}

/**
 * Detects MailboxNotEnabledForRESTAPI from Graph and rethrows with
 * actionable guidance about reassigning an Exchange Online license.
 */
export function rethrow_if_mailbox_not_licensed(err: unknown): void {
  const graph_err = err as Record<string, unknown>;
  const code = String(graph_err.code ?? '');
  const message = err instanceof Error ? err.message : String(err);

  if (code === 'MailboxNotEnabledForRESTAPI' || message.includes('MailboxNotEnabledForRESTAPI')) {
    throw new Error(
      `The mailbox is not licensed for API access (MailboxNotEnabledForRESTAPI).\n` +
        `This typically happens when the user's Exchange Online license has been removed.\n` +
        `The mailbox data is retained for 30 days after license removal, but cannot be\n` +
        `accessed via the Graph API until a license is reassigned.\n\n` +
        `To back up or restore this mailbox:\n` +
        `  1. Reassign an Exchange Online license to the user in Microsoft 365 admin center\n` +
        `  2. Wait a few minutes for the mailbox to reconnect\n` +
        `  3. Run the operation again\n` +
        `  4. Remove the license after the operation completes (if desired)`,
    );
  }
}

/** Returns true when the error carries a transient HTTP status (429, 503, 504). */
export function is_transient_error(err: unknown): boolean {
  const status = (err as Record<string, unknown>).statusCode;
  return typeof status === 'number' && RETRYABLE_STATUS_CODES.has(status);
}

/**
 * Wraps a Graph API call with exponential backoff retries for transient errors.
 * Respects the Retry-After header from 429 responses when available.
 */
export async function with_graph_retry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!is_transient_error(err) || attempt === MAX_RETRIES) throw err;

      const retry_after = extract_retry_after(err);
      const delay = retry_after ?? BASE_DELAY_MS * 2 ** attempt;
      await sleep(delay);
    }
  }

  throw new Error('with_graph_retry: unreachable');
}

/** Extracts the Retry-After header value (in ms) from a Graph error, if present. */
function extract_retry_after(err: unknown): number | undefined {
  const headers = (err as Record<string, unknown>).headers as Record<string, string> | undefined;
  const value = headers?.['retry-after'] ?? headers?.['Retry-After'];
  if (!value) return undefined;
  const seconds = parseInt(value, 10);
  return isNaN(seconds) ? undefined : seconds * 1000;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
