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
