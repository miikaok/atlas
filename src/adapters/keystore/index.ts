export { EnvelopeKeyService } from './envelope-key-service.adapter';
export { DEFAULT_KDF_STRATEGY, KDF_STRATEGIES, KDF_SCRYPT, type KdfStrategy } from './kdf-strategy';
export {
  DEK_BLOB_VERSION,
  build_header_bytes,
  parse_dek_blob,
  serialize_dek_blob,
  type DekBlobHeader,
  type ParsedDekBlob,
} from './dek-blob-codec';
