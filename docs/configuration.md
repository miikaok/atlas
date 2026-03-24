# Configuration

Atlas loads configuration from three sources, merged in this order (later wins):

1. **Config file** — `atlas.config.json` or `.atlas/config.json` (searched in cwd, then `~/.atlas/`)
2. **`.env` file** — loaded via dotenv; does not overwrite existing environment variables
3. **Environment variables** — always take precedence

This precedence means you can set defaults in a config file, override specific values in `.env` for a particular deployment, and use environment variables for CI/CD or container orchestration where secrets are injected at runtime.

## Reference

| Variable                      | Config field            | Required | Description                                    |
| ----------------------------- | ----------------------- | -------- | ---------------------------------------------- |
| `ATLAS_TENANT_ID`             | `tenant_id`             | yes      | Azure AD tenant ID                             |
| `ATLAS_CLIENT_ID`             | `client_id`             | yes      | App registration client ID                     |
| `ATLAS_CLIENT_SECRET`         | `client_secret`         | yes      | App registration client secret                 |
| `ATLAS_S3_ENDPOINT`           | `s3_endpoint`           | yes      | S3 endpoint URL (e.g. `http://localhost:9000`) |
| `ATLAS_S3_ACCESS_KEY`         | `s3_access_key`         | yes      | S3 access key                                  |
| `ATLAS_S3_SECRET_KEY`         | `s3_secret_key`         | yes      | S3 secret key                                  |
| `ATLAS_S3_REGION`             | `s3_region`             | no       | S3 region (default: `us-east-1`)               |
| `ATLAS_ENCRYPTION_PASSPHRASE` | `encryption_passphrase` | yes      | Master passphrase for envelope encryption      |

## OneDrive Workload Notes

OneDrive backup uses the same Atlas configuration fields as mailbox backup. There are **no additional storage or encryption variables** for OneDrive in Option A.

- Owner scope is passed at runtime via CLI (`atlas onedrive ... --owner`) or SDK (`backupOneDrive(ownerId, ...)`).
- Data is written under `onedrive/` prefixes inside the same tenant bucket.
- The same Azure AD app credentials are reused. For OneDrive commands, the app must have Microsoft Graph **Application** permissions `Files.Read.All` and `Sites.Read.All` (with admin consent).

## Config File Example

```json
{
  "tenant_id": "your-azure-tenant-id",
  "client_id": "app-client-id",
  "client_secret": "app-client-secret",
  "s3_endpoint": "http://localhost:9000",
  "s3_access_key": "minioadmin",
  "s3_secret_key": "minioadmin",
  "encryption_passphrase": "my-secret-passphrase"
}
```

Atlas searches for a config file in this order:

1. `./atlas.config.json`
2. `./.atlas/config.json`
3. `~/.atlas/config.json`

The first file found is loaded. Values from the config file can be overridden by `.env` entries and environment variables.

## Invalid Configuration

If a required field is missing or invalid, Atlas exits immediately with a clear error listing every missing field. It will not start a backup with partial configuration -- this fail-fast behavior prevents silent failures where a run appears successful but is missing critical settings like the encryption passphrase.

## S3 Path Style

Atlas uses `forcePathStyle: true` when constructing the S3 client. This is **required** for MinIO and most self-hosted S3-compatible endpoints, which use path-style URLs (`http://host:9000/bucket-name`) rather than virtual-hosted-style (`http://bucket-name.host:9000`). If you are using AWS S3 directly, this setting is still compatible -- AWS S3 supports both styles.

::: danger Secure Your Configuration Files
The config file and `.env` file contain sensitive credentials: Azure client secrets, S3 access keys, and the encryption passphrase. On Linux, restrict file permissions immediately:

```bash
chmod 600 .env atlas.config.json
```

Never commit these files to version control. The included `.gitignore` already excludes `.env`, but verify that your config file is also excluded. In multi-user environments, ensure only the service account running Atlas can read these files.
:::
