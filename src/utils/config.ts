import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { config as load_dotenv } from 'dotenv';

export interface AtlasConfig {
  readonly tenant_id: string;
  readonly client_id: string;
  readonly client_secret: string;
  readonly s3_endpoint: string;
  readonly s3_access_key: string;
  readonly s3_secret_key: string;
  readonly s3_region: string;
  readonly encryption_passphrase: string;
}

export const ATLAS_CONFIG_TOKEN = Symbol.for('AtlasConfig');

const CONFIG_FILE_NAMES = ['atlas.config.json', join('.atlas', 'config.json')];

const ENV_MAP: Record<string, keyof AtlasConfig> = {
  ATLAS_TENANT_ID: 'tenant_id',
  ATLAS_CLIENT_ID: 'client_id',
  ATLAS_CLIENT_SECRET: 'client_secret',
  ATLAS_S3_ENDPOINT: 's3_endpoint',
  ATLAS_S3_ACCESS_KEY: 's3_access_key',
  ATLAS_S3_SECRET_KEY: 's3_secret_key',
  ATLAS_S3_REGION: 's3_region',
  ATLAS_ENCRYPTION_PASSPHRASE: 'encryption_passphrase',
};

/**
 * Loads Atlas configuration by merging sources in this order
 * (later sources override earlier ones):
 *   1. atlas.config.json file
 *   2. .env file (loaded into process.env via dotenv, does NOT overwrite existing vars)
 *   3. Real environment variables (always win)
 * Throws if any required field is missing after merging.
 */
export function load_config(): AtlasConfig {
  load_dotenv();
  const file_config = try_load_config_file();
  const env_overrides = read_env_overrides();
  return merge_and_validate({ ...file_config, ...env_overrides });
}

/**
 * Searches for a config file in the current directory and the user's
 * home directory. Returns the parsed contents, or an empty object if
 * no file is found.
 */
export function try_load_config_file(): Partial<AtlasConfig> {
  const search_dirs = [process.cwd(), homedir()];

  for (const dir of search_dirs) {
    for (const name of CONFIG_FILE_NAMES) {
      const file_path = resolve(dir, name);
      if (existsSync(file_path)) {
        return parse_config_file(file_path);
      }
    }
  }

  return {};
}

/** Reads and JSON-parses a single config file. */
function parse_config_file(file_path: string): Partial<AtlasConfig> {
  const raw = readFileSync(file_path, 'utf-8');
  const parsed: unknown = JSON.parse(raw);

  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`Config file ${file_path} must contain a JSON object`);
  }

  return parsed as Partial<AtlasConfig>;
}

/**
 * Reads ATLAS_* environment variables and maps them to config fields.
 * Only includes variables that are actually set.
 */
export function read_env_overrides(): Partial<AtlasConfig> {
  const overrides: Partial<AtlasConfig> = {};

  for (const [env_key, config_key] of Object.entries(ENV_MAP)) {
    const value = process.env[env_key];
    if (value !== undefined && value !== '') {
      (overrides as Record<string, string>)[config_key] = value;
    }
  }

  return overrides;
}

/**
 * Validates that all required fields are present and returns a
 * fully typed AtlasConfig. Throws a descriptive error listing
 * every missing field.
 */
export function merge_and_validate(partial: Partial<AtlasConfig>): AtlasConfig {
  const required_fields: (keyof AtlasConfig)[] = [
    'tenant_id',
    'client_id',
    'client_secret',
    's3_endpoint',
    's3_access_key',
    's3_secret_key',
    'encryption_passphrase',
  ];
  const missing = required_fields.filter((f) => !partial[f]);

  if (missing.length > 0) {
    throw new Error(
      `Missing required config fields: ${missing.join(', ')}. ` +
        'Provide them via atlas.config.json or ATLAS_* environment variables.',
    );
  }

  return {
    tenant_id: partial.tenant_id!,
    client_id: partial.client_id!,
    client_secret: partial.client_secret!,
    s3_endpoint: partial.s3_endpoint!,
    s3_access_key: partial.s3_access_key!,
    s3_secret_key: partial.s3_secret_key!,
    s3_region: partial.s3_region || 'us-east-1',
    encryption_passphrase: partial.encryption_passphrase!,
  };
}
