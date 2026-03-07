export interface ObjectStorage {
  /** Writes an object to storage under the given key. */
  put(key: string, data: Buffer, metadata?: Record<string, string>): Promise<void>;

  /** Reads the full content of an object from storage. */
  get(key: string): Promise<Buffer>;

  /** Removes an object from storage. */
  delete(key: string): Promise<void>;

  /** Returns true if the key exists in storage. */
  exists(key: string): Promise<boolean>;

  /** Lists all keys that share the given prefix. */
  list(prefix: string): Promise<string[]>;
}

export const OBJECT_STORAGE_TOKEN = Symbol.for('ObjectStorage');
