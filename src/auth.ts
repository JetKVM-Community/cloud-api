import type { MiddlewareHandler } from "hono";
import * as jose from "jose";
import { UnauthorizedError } from "./errors";
import type { AppType } from "./env";

export function getAllowedIdentities(
  allowed?: string,
): Set<string> | null {
  if (!allowed) return null;
  const list = allowed
    .split(",")
    .map((id) => id.trim().toLowerCase())
    .filter(Boolean);
  return list.length > 0 ? new Set(list) : null;
}

export const isIdentityAllowed = (
  identity?: string | null,
  allowedSet?: Set<string> | null,
) => {
  if (!allowedSet) return true;
  const normalized = identity?.trim().toLowerCase();
  if (!normalized) return false;
  return allowedSet.has(normalized);
};

// ---------------------------------------------------------------------------
// Generic OIDC discovery cache
// ---------------------------------------------------------------------------
interface OidcDiscovery {
  issuer: string;
  jwks_uri: string;
}

let cachedDiscovery: OidcDiscovery | null = null;
let cachedJWKS: jose.FlattenedJWSInput extends infer _T
  ? ReturnType<typeof jose.createRemoteJWKSet>
  : never;

async function getOidcDiscovery(issuer: string): Promise<OidcDiscovery> {
  if (cachedDiscovery) return cachedDiscovery;
  const url = `${issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`;
  const resp = await fetch(url);
  cachedDiscovery = (await resp.json()) as OidcDiscovery;
  return cachedDiscovery;
}

function getJWKS(jwksUri: string) {
  if (!cachedJWKS) {
    cachedJWKS = jose.createRemoteJWKSet(new URL(jwksUri));
  }
  return cachedJWKS;
}

// ---------------------------------------------------------------------------
// Token verification — uses OIDC discovery to resolve JWKS & issuer
// ---------------------------------------------------------------------------

export const verifyToken = async (
  idToken: string,
  issuer: string,
  clientId: string,
) => {
  try {
    const discovery = await getOidcDiscovery(issuer);
    const JWKS = getJWKS(discovery.jwks_uri);

    const { payload } = await jose.jwtVerify(idToken, JWKS, {
      issuer: discovery.issuer,
      audience: clientId,
    });
    return payload;
  } catch (e) {
    console.error(e);
    return null;
  }
};

/**
 * Hono middleware: verifies the session id_token is valid.
 */
export const authenticated: MiddlewareHandler<AppType> = async (c, next) => {
  const session = c.get("session");
  const idToken = session?.id_token;
  if (!idToken) throw new UnauthorizedError();

  const payload = await verifyToken(
    idToken,
    c.env.OIDC_ISSUER,
    c.env.OIDC_CLIENT_ID,
  );
  if (!payload) throw new UnauthorizedError();
  if (!payload.exp) throw new UnauthorizedError();

  if (new Date(payload.exp * 1000) < new Date()) {
    throw new UnauthorizedError();
  }

  const email = (payload as { email?: string }).email;
  const allowedIdentities = getAllowedIdentities(c.env.ALLOWED_IDENTITIES);
  if (!isIdentityAllowed(email, allowedIdentities)) {
    throw new UnauthorizedError(
      "Account is not in the allowlist",
      "account_not_allowed",
    );
  }

  await next();
};

