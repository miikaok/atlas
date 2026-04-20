import { describe, it, expect } from 'vitest';
import { DefaultKeyService } from '@/adapters/keystore/key-service.adapter';

describe('DefaultKeyService', () => {
  const svc = new DefaultKeyService();

  it('throws on encrypt', async () => {
    await expect(svc.encrypt(Buffer.from('x'))).rejects.toThrow('not implemented');
  });

  it('throws on decrypt', async () => {
    await expect(svc.decrypt(Buffer.from('x'))).rejects.toThrow('not implemented');
  });

  it('throws on generate_data_key', async () => {
    await expect(svc.generate_data_key()).rejects.toThrow('not implemented');
  });
});
