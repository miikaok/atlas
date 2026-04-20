# Azure AD Setup

Atlas authenticates with Microsoft Graph using the **OAuth2 Client Credentials flow** via `@azure/identity` `ClientSecretCredential`. This flow authenticates the application itself (not a user), which has specific security implications covered below.

## Required Graph API Permissions

All permissions are **Application** type (not Delegated). The Client Credentials flow does not act on behalf of a user, so delegated permissions are not applicable.

| Permission             | Type        | Why It's Needed                                         | Required For                     |
| ---------------------- | ----------- | ------------------------------------------------------- | -------------------------------- |
| `Mail.Read`            | Application | Read mailbox contents via Graph API                     | Backup, list, read, save, verify |
| `Mail.ReadWrite`       | Application | Restore messages and create folders in target mailboxes | Restore only                     |
| `User.Read.All`        | Application | Enumerate users and resolve mailbox IDs                 | User discovery                   |
| `MailboxSettings.Read` | Application | Read mailbox metadata and folder structure              | Folder enumeration               |
| `Reports.Read.All`     | Application | Access mailbox usage reports for size data              | `atlas mailboxes` size column (optional) |

::: tip Start with Read-Only
If you only need backups (no restore), grant only `Mail.Read` instead of `Mail.ReadWrite`. This limits the application's ability to modify mailbox contents, reducing the blast radius if the client secret is compromised. Add `Mail.ReadWrite` later only when restore functionality is needed.
:::

## Creating the App Registration

1. Sign in to the [Azure Portal](https://portal.azure.com) and navigate to **Microsoft Entra ID** (formerly Azure Active Directory).
2. In the left sidebar, select **App registrations**, then click **New registration**.
3. Fill in the registration form:
   - **Name**: Choose a descriptive name, e.g. `Atlas M365 Backup`.
   - **Supported account types**: Select **Accounts in this organizational directory only (Single tenant)**.
   - **Redirect URI**: Leave blank. The Client Credentials flow does not use redirect URIs.
4. Click **Register**. You will be taken to the application overview page.
5. Copy the **Application (client) ID** and **Directory (tenant) ID** from the overview. You need both for Atlas configuration (`ATLAS_CLIENT_ID` and `ATLAS_TENANT_ID`).

### Adding API Permissions

6. In the left sidebar, select **API permissions**, then click **Add a permission**.
7. Choose **Microsoft Graph**, then select **Application permissions**.
8. Search for and add each permission from the table above. For a backup-only setup, the minimum required set is `Mail.Read`, `User.Read.All`, and `MailboxSettings.Read`.
9. After adding all permissions, click **Grant admin consent for [your tenant]**. A confirmation dialog will appear. Click **Yes**.

The status column next to each permission must show a green checkmark (**Granted for [tenant]**). Permissions without admin consent will cause authentication errors at runtime.

## Creating a Client Secret

10. In the left sidebar, select **Certificates & secrets**, then click **Client secrets**.
11. Click **New client secret**.
12. Enter a description (e.g. `Atlas production`) and choose an expiry period. 24 months is the maximum Azure allows; 12 months is a reasonable default for production.
13. Click **Add**.

::: warning Secret Value Shown Once
The secret **Value** is only shown immediately after creation. Copy it now and store it in your secrets manager. Once you navigate away from this page, the value is no longer retrievable -- you must create a new secret.
:::

14. Copy the **Value** (not the Secret ID) and set it as `ATLAS_CLIENT_SECRET` in your Atlas environment.

## Security Implications of Client Credentials

The Client Credentials flow means Atlas authenticates **as the application itself**, not on behalf of any specific user. This has important consequences:

- **Tenant-wide access** — the application has permission to read (and potentially write) **every mailbox** in the tenant. There is no per-user consent or per-mailbox scoping at the API level.
- **No user interaction** — authentication is fully automated using a client ID and secret. No MFA, no user prompt, no interactive login.
- **Secret is the only barrier** — anyone who obtains the client secret can access all mailboxes in the tenant with whatever permissions are granted.

This makes the client secret one of the most sensitive credentials in your Atlas deployment. Protect it accordingly:

- Store it in a secrets manager (Azure Key Vault, HashiCorp Vault, etc.), not in plaintext files on shared drives.
- Rotate the secret regularly (every 90 days minimum for production environments).
- Monitor Azure AD sign-in logs for unexpected application authentications.

### Certificate-Based Authentication

For higher security, Azure AD supports **certificate-based authentication** as an alternative to client secrets. Certificates are harder to exfiltrate than string secrets and can be stored in hardware security modules (HSMs). Atlas currently uses client secrets, but Azure AD allows both methods for the same application registration -- you can create a certificate credential alongside or instead of a secret.

## Client Secret Rotation

Client secrets have a finite expiry. When a secret expires, Atlas will fail with the following error on every authentication attempt:

```
AADSTS7000215: Invalid client secret provided. Ensure the secret being sent in the request is the client secret value, not the client secret ID.
```

Despite the misleading wording, this error means the secret has **expired** (or the wrong value was provided). Check the expiry date in **Certificates & secrets** first.

### Zero-Downtime Rotation Procedure

1. In the Azure Portal, navigate to **App registrations → [your app] → Certificates & secrets → Client secrets**.
2. Click **New client secret**, add a description (e.g. `Atlas production 2027`), and set the expiry.
3. Copy the new secret **Value** immediately.
4. Update `ATLAS_CLIENT_SECRET` in your Atlas environment or secrets manager with the new value.
5. Restart or re-run Atlas to confirm authentication succeeds with the new secret.
6. Return to the Azure Portal and **Delete** the old (expired or expiring) secret.

Adding the new secret before removing the old one ensures Atlas is never in a state where it has no valid credentials. Both secrets are valid simultaneously until you delete the old one.

::: tip Set a Calendar Reminder
Azure does not send expiry warnings by default unless you configure monitoring. Set a calendar reminder 2--4 weeks before the secret expiry date so you have time to rotate without an incident.
:::
