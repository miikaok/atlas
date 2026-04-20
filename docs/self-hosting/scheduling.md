# Scheduling & Bandwidth

Understanding bandwidth requirements is a prerequisite for planning when and how often to schedule backups. Atlas pulls full message bodies and attachments from Microsoft 365 -- the network profile determines whether your schedule is realistic.

## Network and Bandwidth

This is often the most overlooked aspect of deploying Atlas. Understanding the bandwidth profile is critical for professional environments.

### Why Bandwidth Matters

Atlas pulls **full message bodies and all attachments** from Microsoft 365 via the Graph API over HTTPS. For a mailbox with 10 GB of email and attachments, a full initial backup will transfer approximately 10 GB of data over the internet. Delta (incremental) syncs after the first run only transfer new and changed messages, which is dramatically less -- but the initial backup is a significant transfer.

When you run tenant-wide backups with multiple concurrent workers (`-C 4` is the default), the bandwidth requirement multiplies. Four workers backing up four large mailboxes simultaneously can easily saturate a typical office internet connection.

### Professional Deployment Guidance

::: danger Business Network Impact
In professional environments, **always schedule backups during off-hours** (nights, weekends). Running Atlas during business hours on a shared internet connection will degrade network performance for all users -- video calls will drop, file downloads will slow, and cloud applications will become unresponsive.
:::

For organizations where off-hours scheduling is not sufficient, the recommended approach is to run the backup server on a **separate ISP connection or VLAN** that does not share bandwidth with employee traffic. This ensures that Graph API transfers never compete with business-critical network usage.

### Microsoft Graph API Throttling

Even with unlimited bandwidth on your side, Microsoft imposes its own limits. The Graph API returns **HTTP 429 (Too Many Requests)** responses when you exceed rate limits. Atlas handles this automatically with exponential backoff (up to 12 retries, honoring the `Retry-After` header), but it means effective throughput has a ceiling set by Microsoft, not your network.

Monitor your first full tenant backup closely to understand the real-world throughput for your environment. Use this baseline to plan scheduling and capacity.

### Sizing Estimates

| Scenario                 | Data Transfer (Full Backup) | Delta Sync                     |
| ------------------------ | --------------------------- | ------------------------------ |
| Single 5 GB mailbox      | ~5 GB                       | Only changes (typically KB-MB) |
| 10 users, avg 10 GB each | ~100 GB                     | Only changes per user          |
| 100 users, avg 5 GB each | ~500 GB                     | Only changes per user          |

These are approximate -- actual sizes depend on attachment volume, HTML email sizes, and how much mail is in each mailbox.

## Automated Backup Scheduling

Atlas is a CLI tool -- it runs, performs the backup, and exits. For continuous protection, schedule it to run automatically.

### Using cron

```bash
# Edit crontab
crontab -e
```

Example schedules:

```cron
# Nightly incremental backup at 2 AM
0 2 * * * /usr/bin/atlas backup >> /var/log/atlas-backup.log 2>&1

# Weekly full backup (ignore delta state) every Sunday at 3 AM
0 3 * * 0 /usr/bin/atlas backup --full >> /var/log/atlas-backup-full.log 2>&1
```

### Using systemd Timers

For more robust scheduling with logging and failure tracking:

```ini
# /etc/systemd/system/atlas-backup.service
[Unit]
Description=Atlas M365 Backup
After=network-online.target docker.service

[Service]
Type=oneshot
ExecStart=/usr/bin/atlas backup
Environment=ATLAS_TENANT_ID=your-tenant-id
Environment=ATLAS_CLIENT_ID=your-client-id
EnvironmentFile=/etc/atlas/atlas.env
```

```ini
# /etc/systemd/system/atlas-backup.timer
[Unit]
Description=Run Atlas backup nightly

[Timer]
OnCalendar=*-*-* 02:00:00
Persistent=true

[Install]
WantedBy=timers.target
```

Enable with:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now atlas-backup.timer
```

::: tip Off-Hours Scheduling
For professional deployments, always schedule backups outside business hours. A nightly 2 AM run avoids competing with daytime internet usage and Microsoft Graph API traffic from other applications in your tenant.
:::
