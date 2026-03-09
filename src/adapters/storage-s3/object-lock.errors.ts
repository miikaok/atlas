export class ObjectLockVersioningDisabledError extends Error {
  constructor(bucket: string) {
    super(
      `Immutability requested, but bucket versioning is disabled for ${bucket}. ` +
        'Enable bucket versioning and Object Lock, or run backup without retention/legal-hold.',
    );
    this.name = 'ObjectLockVersioningDisabledError';
  }
}

export class ObjectLockUnsupportedError extends Error {
  constructor(bucket: string) {
    super(
      `Immutability requested, but Object Lock is not supported or not enabled for bucket ${bucket}.`,
    );
    this.name = 'ObjectLockUnsupportedError';
  }
}

export class ObjectLockModeRejectedError extends Error {
  constructor(bucket: string, mode: string, cause?: unknown) {
    const cause_text = cause instanceof Error ? ` (${cause.message})` : '';
    super(`Backend rejected Object Lock mode ${mode} for bucket ${bucket}.${cause_text}`);
    this.name = 'ObjectLockModeRejectedError';
  }
}
