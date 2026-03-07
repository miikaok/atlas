import { ClientSecretCredential } from '@azure/identity';
import { Client } from '@microsoft/microsoft-graph-client';
import { TokenCredentialAuthenticationProvider } from '@microsoft/microsoft-graph-client/authProviders/azureTokenCredentials/index.js';
import type { AtlasConfig } from '@/utils/config';

export const GRAPH_CLIENT_TOKEN = Symbol.for('GraphClient');

/**
 * Creates an authenticated Microsoft Graph client using the OAuth2
 * client credentials flow. The SDK handles token acquisition, caching,
 * and automatic refresh. Built-in middleware provides retry on 429/5xx
 * and redirect following.
 */
export function create_graph_client(config: AtlasConfig): Client {
  const credential = build_credential(config);
  const auth_provider = build_auth_provider(credential);
  return Client.initWithMiddleware({ authProvider: auth_provider });
}

/** Builds an Azure AD client-secret credential for the given tenant. */
function build_credential(config: AtlasConfig): ClientSecretCredential {
  return new ClientSecretCredential(config.tenant_id, config.client_id, config.client_secret);
}

/** Wraps the credential in a Graph-compatible authentication provider. */
function build_auth_provider(
  credential: ClientSecretCredential,
): TokenCredentialAuthenticationProvider {
  return new TokenCredentialAuthenticationProvider(credential, {
    scopes: ['https://graph.microsoft.com/.default'],
  });
}
