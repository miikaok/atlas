# CLI Commands

Complete reference for the Atlas CLI read and inspection commands. These are the commands used in day-to-day operation: running backups, checking status, browsing backed-up data, and verifying storage readiness.

For restore, export, delete, and replication commands, see [CLI — Recovery & Management](/reference/cli-recovery).

## `atlas backup`

Back up mailboxes from an M365 tenant to object storage. When a mailbox is specified with `-m`, backs up that single mailbox with a per-folder progress dashboard. When no mailbox is specified, discovers all Exchange-licensed mailboxes in the tenant and backs them up in parallel.

**Single mailbox:**

```bash
atlas backup -m user@company.com                      # incremental backup
atlas backup -m user@company.com --full                # force full sync (ignore delta state)
atlas backup -m user@company.com -f Inbox Sent         # specific folders only
atlas backup -m user@company.com -P 50                 # larger page size for fewer API round-trips
atlas backup -m user@company.com --retention-days 30 --lock-mode governance
atlas backup -m user@company.com --retention-days 365 --lock-mode compliance
atlas backup -t <tenant-id> -m user@company.com        # explicit tenant
```

**Full tenant (all licensed mailboxes):**

```bash
atlas backup                                           # back up all licensed mailboxes (4 concurrent)
atlas backup -C 8                                      # increase parallel workers to 8
atlas backup --full                                    # force full sync for all mailboxes
```

| Option                   | Description                                                    |
| ------------------------ | -------------------------------------------------------------- |
| `-m, --mailbox <id>`     | Specific mailbox to back up (backs up all licensed if omitted) |
| `-f, --folder <name...>` | Filter to specific folder(s) by display name                   |
| `--full`                 | Ignore saved delta links, run full enumeration                 |
| `-P, --page-size <n>`    | Graph API page size per delta request (1--100, default 10)     |
| `-C, --concurrency <n>`  | Parallel mailbox count for tenant backup (default 4)           |
| `--retention-days <n>`   | Apply Object Lock retention for `n` days                       |
| `--lock-mode <mode>`     | Object Lock mode (`governance` or `compliance`)                |
| `--require-immutability` | Fail if immutability cannot be enforced                        |
| `-t, --tenant <id>`      | Override tenant ID from config                                 |

::: tip Tenant-wide mode
When no `-m` flag is given, Atlas discovers all Exchange Online-licensed mailboxes via Microsoft Graph, then runs up to `-C` concurrent backup workers. A compact dashboard shows each active worker's mailbox, folder progress, and overall completion. The first Ctrl+C gracefully finishes active mailboxes; a second Ctrl+C force-quits immediately.
:::

::: details Page size tuning
The `--page-size` flag controls how many messages are requested per Graph API delta page via the `Prefer: odata.maxpagesize` header. This is a _hint_ -- the server may return fewer items when response payloads are large (e.g. messages with heavy HTML bodies or many inline images). Lower values reduce memory pressure and allow partial progress to be saved more frequently during interrupts. Higher values reduce HTTP round-trips but increase per-page processing time. The default of 10 is a conservative starting point; increase if you have many small messages and want fewer round-trips.
:::

::: details Immutability behavior
`--retention-days` makes the backup immutable-requested. Atlas resolves retention to an internal UTC `retain_until`, probes bucket capability (versioning + Object Lock), and fails fast when unsupported instead of silently downgrading to mutable writes.
:::

## `atlas status`

Check whether a mailbox backup is up to date by peeking at Microsoft Graph delta state. This does **not** run a backup -- it only queries the delta endpoint with the saved delta links from the latest manifest to detect pending changes.

```bash
atlas status -m user@company.com
atlas status -m user@company.com -t <tenant-id>
```

| Option                  | Description                    |
| ----------------------- | ------------------------------ |
| `-m, --mailbox <email>` | Mailbox to check (required)    |
| `-t, --tenant <id>`     | Override tenant ID from config |

Example output:

```
------------------
-- Atlas Status --
------------------
[*] Tenant:  ec216cb5-...
[*] Mailbox: user@company.com
[*] Last backup: 2026-03-18 14:30 (snap-abc123)

  Folder                      Status              Pending
  ---------------------------------------------------------
  Inbox                       up-to-date          0
  Sent Items                  3 change(s)         3
  Archive                     never backed up     -
  ---------------------------------------------------------

[*] Overall: 3 pending change(s), 1 folder(s) never backed up across 3 folder(s)
```

## `atlas mailboxes`

List tenant mailboxes directly from Microsoft Graph (live data, not from the backup catalog). Shows email address, display name, Exchange Online license status, account status, creation date, and optionally mailbox size.

```bash
atlas mailboxes
atlas mailboxes --licensed-only
atlas mailboxes -t <tenant-id>
```

| Option              | Description                                                |
| ------------------- | ---------------------------------------------------------- |
| `--licensed-only`   | Only show mailboxes with an active Exchange Online license |
| `-t, --tenant <id>` | Override tenant ID from config                             |

::: tip
Mailbox size requires the `Reports.Read.All` Graph API permission. If the permission is not granted, the Size column is omitted without error.
:::

## `atlas storage-check`

Validate immutable backup readiness without running a backup. Reports versioning and Object Lock status.

```bash
atlas storage-check
atlas storage-check --lock-mode governance --retention-days 30
atlas storage-check --lock-mode compliance --retention-days 365
```

| Option                 | Description                                             |
| ---------------------- | ------------------------------------------------------- |
| `--lock-mode <mode>`   | Planned Object Lock mode (`governance` or `compliance`) |
| `--retention-days <n>` | Planned retention period in days                        |
| `-t, --tenant <id>`    | Override tenant ID                                      |

## `atlas list`

Browse backed-up data at three zoom levels. Subjects are hidden by default for data protection.

```bash
atlas list                              # all mailboxes with summary stats
atlas list -m user@company.com          # all snapshots for a mailbox
atlas list -s <snapshot-id>             # messages inside a snapshot (first 50)
atlas list -s <snapshot-id> --all       # all messages
atlas list -s <snapshot-id> -S          # reveal email subjects
```

| Option                  | Description                                                   |
| ----------------------- | ------------------------------------------------------------- |
| `-m, --mailbox <email>` | Show snapshots for this mailbox                               |
| `-s, --snapshot <id>`   | Show messages inside this snapshot                            |
| `--all`                 | Show all messages (default caps at 50)                        |
| `-S, --subjects`        | Reveal email subjects (hidden by default for data protection) |
| `-t, --tenant <id>`     | Override tenant ID                                            |

## `atlas read`

Decrypt and display a single backed-up message. Messages are referenced by their `#` index from `atlas list` output. Attachment metadata (name, MIME type, size) is listed below the body when present.

```bash
atlas read -s <snapshot-id> --message 34
atlas read -s <snapshot-id> --message 34 --raw
```

| Option                | Description                                               |
| --------------------- | --------------------------------------------------------- |
| `-s, --snapshot <id>` | Snapshot containing the message                           |
| `--message <ref>`     | Message `#` from `atlas list`, or full Graph message ID   |
| `--raw`               | Output full JSON blob instead of formatted headers + body |
| `-t, --tenant <id>`   | Override tenant ID                                        |

## `atlas stats`

Show storage statistics for the entire bucket or a specific mailbox. Reports object counts and total storage size across data, attachments, and manifest prefixes.

```bash
atlas stats                            # bucket-level overview
atlas stats -m user@company.com        # mailbox-level breakdown
atlas stats --json                     # raw JSON output
```

| Option                  | Description                                |
| ----------------------- | ------------------------------------------ |
| `-m, --mailbox <email>` | Show statistics for a specific mailbox     |
| `--json`                | Output raw JSON instead of formatted table |
| `-t, --tenant <id>`     | Override tenant ID from config             |

The bucket-level overview shows total object counts and storage consumption across all mailboxes. The mailbox breakdown shows per-prefix statistics (data, attachments, manifests) so you can identify which mailboxes consume the most storage. Use `--json` for programmatic consumption in monitoring scripts or dashboards.

## See Also

- [CLI — Recovery & Management](/reference/cli-recovery) — `restore`, `save`, `verify`, `delete`, `replicate`, `rehydrate`
