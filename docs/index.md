---
layout: home
hero:
  name: M365 Atlas
  text: Secure Microsoft 365 Mailbox Backups
  tagline: Open-source CLI and SDK for encrypted, deduplicated mailbox backups to S3-compatible storage.
  actions:
    - theme: brand
      text: Get Started
      link: /getting-started
    - theme: alt
      text: CLI Reference
      link: /reference/cli
    - theme: alt
      text: View on GitHub
      link: https://github.com/miikaok/atlas

features:
  - title: Per-Tenant Encryption
    details: Each tenant gets a unique AES-256-GCM key derived via scrypt. Data stays encrypted even if storage is breached.
  - title: Content-Addressed Deduplication
    details: Messages and attachments are stored by SHA-256 hash per mailbox. Identical files are stored once.
  - title: Storage-Level Immutability
    details: S3/MinIO Object Lock with time-based retention enforced by storage itself, not app metadata.
  - title: Delta Sync
    details: Microsoft Graph delta queries for incremental backups with automatic full-scan fallback on interrupted runs.
  - title: EML Export
    details: Save backed-up emails as standard .eml files in compressed zip archives with Outlook-compatible folder structure.
  - title: Typed SDK
    details: Programmatic API for embedding in other Node.js applications via the m365-atlas/sdk subpath.
---
