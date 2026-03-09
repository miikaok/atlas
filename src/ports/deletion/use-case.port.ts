export interface DeletionResult {
  readonly deleted_objects: number;
  readonly deleted_manifests: number;
}

export interface DeletionUseCase {
  delete_mailbox_data(tenant_id: string, mailbox_id: string): Promise<DeletionResult>;
  delete_snapshot(tenant_id: string, snapshot_id: string): Promise<DeletionResult>;
  purge_tenant(tenant_id: string): Promise<DeletionResult>;
}
