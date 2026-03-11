import { describe, it, expect } from 'vitest';
import {
  rethrow_if_access_denied,
  rethrow_if_mailbox_not_licensed,
  is_invalid_delta_error,
  is_transient_error,
} from '@/adapters/m365/graph-error-helpers';

describe('rethrow_if_mailbox_not_licensed', () => {
  it('throws with actionable message when error code is MailboxNotEnabledForRESTAPI', () => {
    const err = { code: 'MailboxNotEnabledForRESTAPI', statusCode: 403, message: '' };

    expect(() => rethrow_if_mailbox_not_licensed(err)).toThrow('not licensed for API access');
  });

  it('throws when MailboxNotEnabledForRESTAPI appears in error message', () => {
    const err = new Error('The mailbox is not enabled (MailboxNotEnabledForRESTAPI)');

    expect(() => rethrow_if_mailbox_not_licensed(err)).toThrow(
      'Reassign an Exchange Online license',
    );
  });

  it('does not throw for unrelated errors', () => {
    const err = { code: 'ErrorItemNotFound', statusCode: 404, message: 'Not found' };

    expect(() => rethrow_if_mailbox_not_licensed(err)).not.toThrow();
  });

  it('does not throw for access denied errors (handled separately)', () => {
    const err = { code: 'ErrorAccessDenied', statusCode: 403, message: 'Forbidden' };

    expect(() => rethrow_if_mailbox_not_licensed(err)).not.toThrow();
  });
});

describe('rethrow_if_access_denied', () => {
  it('throws with permission guidance on 403', () => {
    const err = { statusCode: 403 };

    expect(() => rethrow_if_access_denied(err)).toThrow('403 Forbidden');
  });

  it('does not throw for non-403 errors', () => {
    const err = { statusCode: 404 };

    expect(() => rethrow_if_access_denied(err)).not.toThrow();
  });
});

describe('is_invalid_delta_error', () => {
  it('detects syncStateNotFound', () => {
    expect(is_invalid_delta_error(new Error('SyncStateNotFound'))).toBe(true);
  });

  it('detects resyncRequired', () => {
    expect(is_invalid_delta_error(new Error('resyncRequired'))).toBe(true);
  });

  it('returns false for unrelated errors', () => {
    expect(is_invalid_delta_error(new Error('timeout'))).toBe(false);
  });
});

describe('is_transient_error', () => {
  it.each([429, 503, 504])('returns true for status %i', (status) => {
    expect(is_transient_error({ statusCode: status })).toBe(true);
  });

  it('returns false for 400', () => {
    expect(is_transient_error({ statusCode: 400 })).toBe(false);
  });
});
