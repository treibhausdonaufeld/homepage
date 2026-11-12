/** Login der Raum-AG über Authentik (OpenID Connect, Authorization Code + PKCE). */
import * as client from 'openid-client';
import { config } from '../config';

let configPromise: Promise<client.Configuration> | null = null;

export const oidcEnabled = () => !!(config.oidc.issuer && config.oidc.clientId);

function getConfig(): Promise<client.Configuration> {
  if (!configPromise) {
    configPromise = client
      .discovery(new URL(config.oidc.issuer), config.oidc.clientId, config.oidc.clientSecret || undefined)
      .catch((err) => {
        configPromise = null;
        throw err;
      });
  }
  return configPromise;
}

export const redirectUri = () => `${config.publicUrl}/admin/callback`;

export async function startLogin() {
  const cfg = await getConfig();
  const verifier = client.randomPKCECodeVerifier();
  const challenge = await client.calculatePKCECodeChallenge(verifier);
  const state = client.randomState();
  const url = client.buildAuthorizationUrl(cfg, {
    redirect_uri: redirectUri(),
    scope: config.oidc.scopes,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
  });
  return { url: url.href, verifier, state };
}

export interface OidcUser {
  sub: string;
  name: string;
  email?: string;
  groups: string[];
}

export async function finishLogin(currentUrl: URL, verifier: string, state: string): Promise<OidcUser> {
  const cfg = await getConfig();
  // Hinter dem Reverse-Proxy die öffentliche Adresse verwenden
  const pub = new URL(redirectUri());
  pub.search = currentUrl.search;
  const tokens = await client.authorizationCodeGrant(cfg, pub, {
    pkceCodeVerifier: verifier,
    expectedState: state,
  });
  let claims: Record<string, unknown> = { ...(tokens.claims() ?? {}) };
  if (!Array.isArray(claims.groups)) {
    try {
      const info = await client.fetchUserInfo(cfg, tokens.access_token, String(claims.sub));
      claims = { ...claims, ...info };
    } catch {
      // ohne Userinfo weiter
    }
  }
  const groups = Array.isArray(claims.groups) ? (claims.groups as string[]) : [];
  return {
    sub: String(claims.sub),
    name: String(claims.name ?? claims.preferred_username ?? claims.email ?? claims.sub),
    email: claims.email ? String(claims.email) : undefined,
    groups,
  };
}
