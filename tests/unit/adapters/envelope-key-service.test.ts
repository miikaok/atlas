import { describe, it, expect } from 'vitest';
import { EnvelopeKeyService, derive_kek } from '@/adapters/keystore/envelope-key-service.adapter';

describe('EnvelopeKeyService', () => {
  const passphrase = 'test-passphrase';
  const tenant_id = 'tenant-abc';

  describe('derive_kek', () => {
    it('produces a 32-byte key', () => {
      const kek = derive_kek(passphrase, tenant_id);
      expect(kek.length).toBe(32);
    });

    it('is deterministic for same inputs', () => {
      const kek1 = derive_kek(passphrase, tenant_id);
      const kek2 = derive_kek(passphrase, tenant_id);
      expect(kek1.equals(kek2)).toBe(true);
    });

    it('differs across tenants', () => {
      const kek_a = derive_kek(passphrase, 'tenant-a');
      const kek_b = derive_kek(passphrase, 'tenant-b');
      expect(kek_a.equals(kek_b)).toBe(false);
    });

    it('differs across passphrases', () => {
      const kek1 = derive_kek('pass-1', tenant_id);
      const kek2 = derive_kek('pass-2', tenant_id);
      expect(kek1.equals(kek2)).toBe(false);
    });
  });

  describe('encrypt / decrypt round-trip', () => {
    it('round-trips arbitrary data', () => {
      const svc = new EnvelopeKeyService(passphrase, tenant_id);
      const dek = svc.generate_dek();
      const plaintext = Buffer.from('hello world, this is a test message');

      const ciphertext = svc.encrypt(plaintext, dek);
      const decrypted = svc.decrypt(ciphertext, dek);
      expect(decrypted.equals(plaintext)).toBe(true);
    });

    it('produces different ciphertext each time (random IV)', () => {
      const svc = new EnvelopeKeyService(passphrase, tenant_id);
      const dek = svc.generate_dek();
      const plaintext = Buffer.from('same data');

      const ct1 = svc.encrypt(plaintext, dek);
      const ct2 = svc.encrypt(plaintext, dek);
      expect(ct1.equals(ct2)).toBe(false);
    });

    it('ciphertext is longer than plaintext (IV + auth tag)', () => {
      const svc = new EnvelopeKeyService(passphrase, tenant_id);
      const dek = svc.generate_dek();
      const plaintext = Buffer.from('test');

      const ciphertext = svc.encrypt(plaintext, dek);
      expect(ciphertext.length).toBe(plaintext.length + 12 + 16);
    });

    it('rejects tampered ciphertext', () => {
      const svc = new EnvelopeKeyService(passphrase, tenant_id);
      const dek = svc.generate_dek();
      const ciphertext = svc.encrypt(Buffer.from('data'), dek);

      ciphertext[ciphertext.length - 1] ^= 0xff;
      expect(() => svc.decrypt(ciphertext, dek)).toThrow();
    });

    it('rejects truncated ciphertext', () => {
      const svc = new EnvelopeKeyService(passphrase, tenant_id);
      const dek = svc.generate_dek();
      const short = Buffer.alloc(10);

      expect(() => svc.decrypt(short, dek)).toThrow('too short');
    });
  });

  describe('wrap / unwrap DEK', () => {
    it('round-trips a DEK through wrap and unwrap', () => {
      const svc = new EnvelopeKeyService(passphrase, tenant_id);
      const dek = svc.generate_dek();

      const wrapped = svc.wrap_dek(dek);
      const unwrapped = svc.unwrap_dek(wrapped);
      expect(unwrapped.equals(dek)).toBe(true);
    });

    it('wrapped DEK does not contain the plaintext DEK', () => {
      const svc = new EnvelopeKeyService(passphrase, tenant_id);
      const dek = svc.generate_dek();
      const wrapped = svc.wrap_dek(dek);

      expect(wrapped.includes(dek)).toBe(false);
    });

    it('cannot unwrap with wrong tenant passphrase', () => {
      const svc_a = new EnvelopeKeyService(passphrase, 'tenant-a');
      const svc_b = new EnvelopeKeyService(passphrase, 'tenant-b');
      const dek = svc_a.generate_dek();

      const wrapped = svc_a.wrap_dek(dek);
      expect(() => svc_b.unwrap_dek(wrapped)).toThrow();
    });
  });

  describe('generate_dek', () => {
    it('produces a 32-byte key', () => {
      const svc = new EnvelopeKeyService(passphrase, tenant_id);
      expect(svc.generate_dek().length).toBe(32);
    });

    it('produces unique keys', () => {
      const svc = new EnvelopeKeyService(passphrase, tenant_id);
      const k1 = svc.generate_dek();
      const k2 = svc.generate_dek();
      expect(k1.equals(k2)).toBe(false);
    });
  });
});
