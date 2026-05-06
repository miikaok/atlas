export type StorageObjectLockMode = 'GOVERNANCE' | 'COMPLIANCE';

export interface StorageObjectLockPolicy {
  readonly mode?: StorageObjectLockMode | undefined;
  readonly retain_until?: string | undefined;
}

export interface StorageImmutabilityProbeRequest {
  readonly mode?: StorageObjectLockMode | undefined;
  readonly retain_until?: string | undefined;
}

export interface StorageImmutabilityProbeResult {
  readonly bucket: string;
  readonly reachable: boolean;
  readonly versioning_enabled: boolean;
  readonly object_lock_enabled: boolean;
  readonly mode_supported: boolean;
}

export interface StorageObjectVersion {
  readonly key: string;
  readonly version_id: string;
  readonly is_delete_marker: boolean;
}

export interface ObjectStorage {
  /** Writes an object to storage under the given key. */
  put(
    key: string,
    data: Buffer,
    metadata?: Record<string, string>,
    object_lock_policy?: StorageObjectLockPolicy,
  ): Promise<void>;

  /** Reads the full content of an object from storage. */
  get(key: string): Promise<Buffer>;

  /** Removes an object from storage. */
  delete(key: string): Promise<void>;

  /** Returns true if the key exists in storage. */
  exists(key: string): Promise<boolean>;

  /** Lists all keys that share the given prefix. */
  list(prefix: string): Promise<string[]>;

  /** Lists object versions and delete markers for a prefix. */
  list_versions(prefix: string): Promise<StorageObjectVersion[]>;

  /** Deletes a specific object version or delete marker. */
  delete_version(key: string, version_id: string): Promise<void>;

  /** Validates bucket immutability readiness for optional lock policy. */
  probe_immutability(
    request?: StorageImmutabilityProbeRequest,
  ): Promise<StorageImmutabilityProbeResult>;
}
