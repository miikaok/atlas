import { inject, injectable } from 'inversify';
import type { TenantContextFactory } from '@/ports/tenant-context.port';
import { TENANT_CONTEXT_FACTORY_TOKEN } from '@/ports/tenant-context.port';
import type { ManifestRepository } from '@/ports/manifest-repository.port';
import { MANIFEST_REPOSITORY_TOKEN } from '@/ports/manifest-repository.port';
import type { Manifest, AttachmentEntry } from '@/domain/manifest';

export interface MailboxSummary {
  readonly mailbox_id: string;
  readonly snapshot_count: number;
  readonly total_objects: number;
  readonly total_size_bytes: number;
  readonly last_backup_at: Date;
}

export interface ReadMessageResult {
  readonly message: Record<string, unknown>;
  readonly attachments: AttachmentEntry[];
}

@injectable()
export class CatalogService {
  constructor(
    @inject(TENANT_CONTEXT_FACTORY_TOKEN) private readonly _tenant_factory: TenantContextFactory,
    @inject(MANIFEST_REPOSITORY_TOKEN) private readonly _manifests: ManifestRepository,
  ) {}

  /**
   * Groups all manifests by mailbox, picking the latest per mailbox
   * for summary stats (object count, size, last backup time).
   */
  async list_mailboxes(tenant_id: string): Promise<MailboxSummary[]> {
    const ctx = await this._tenant_factory.create(tenant_id);
    const all = await this._manifests.list_all_manifests(ctx);

    const by_mailbox = group_by_mailbox(all);
    return build_mailbox_summaries(by_mailbox);
  }

  /** Returns every manifest for a given mailbox, sorted newest-first. */
  async list_snapshots(tenant_id: string, mailbox_id: string): Promise<Manifest[]> {
    mailbox_id = mailbox_id.toLowerCase();
    const ctx = await this._tenant_factory.create(tenant_id);
    const all = await this._manifests.list_all_manifests(ctx);

    return all
      .filter((m) => m.mailbox_id === mailbox_id)
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  }

  /** Loads and returns one manifest by snapshot ID. */
  async get_snapshot_detail(tenant_id: string, snapshot_id: string): Promise<Manifest | undefined> {
    const ctx = await this._tenant_factory.create(tenant_id);
    return this._manifests.find_by_snapshot(ctx, snapshot_id);
  }

  /**
   * Finds a message entry in the manifest, fetches the encrypted blob
   * from object storage, decrypts it, and returns the parsed JSON
   * together with any attachment metadata from the manifest.
   */
  async read_message(
    tenant_id: string,
    snapshot_id: string,
    message_id: string,
  ): Promise<ReadMessageResult | undefined> {
    const ctx = await this._tenant_factory.create(tenant_id);
    const manifest = await this._manifests.find_by_snapshot(ctx, snapshot_id);
    if (!manifest) return undefined;

    const entry = manifest.entries.find((e) => e.object_id === message_id);
    if (!entry) return undefined;

    const encrypted = await ctx.storage.get(entry.storage_key);
    const json = ctx.decrypt(encrypted);
    const message = JSON.parse(json.toString('utf-8')) as Record<string, unknown>;
    return { message, attachments: entry.attachments ?? [] };
  }
}

/** Groups manifests into a map keyed by mailbox_id. */
function group_by_mailbox(manifests: Manifest[]): Map<string, Manifest[]> {
  const map = new Map<string, Manifest[]>();
  for (const m of manifests) {
    const arr = map.get(m.mailbox_id) ?? [];
    arr.push(m);
    map.set(m.mailbox_id, arr);
  }
  return map;
}

/** Builds one MailboxSummary per group using the latest manifest's stats. */
function build_mailbox_summaries(groups: Map<string, Manifest[]>): MailboxSummary[] {
  const summaries: MailboxSummary[] = [];

  for (const [mailbox_id, manifests] of groups) {
    manifests.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    const latest = manifests[0]!;

    summaries.push({
      mailbox_id,
      snapshot_count: manifests.length,
      total_objects: latest.total_objects,
      total_size_bytes: latest.total_size_bytes,
      last_backup_at: new Date(latest.created_at),
    });
  }

  return summaries.sort((a, b) => a.mailbox_id.localeCompare(b.mailbox_id));
}
