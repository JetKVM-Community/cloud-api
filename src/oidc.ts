import type { Context } from "hono";
import type { AppType } from "./env";
import { BadRequestError, UnauthorizedError } from "./errors";
import { isIdentityAllowed, getAllowedIdentities } from "./auth";
import { randomHex } from "./helpers";

// ---------------------------------------------------------------------------
// Generic OIDC Discovery
// ---------------------------------------------------------------------------
interface OidcConfig {
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint: string;
}

let cachedOidcConfig: OidcConfig | null = null;

async function getOidcConfig(issuer: string): Promise<OidcConfig> {
  if (cachedOidcConfig) return cachedOidcConfig;
  const url = `${issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`;
  const resp = await fetch(url);
  cachedOidcConfig = (await resp.json()) as OidcConfig;
  return cachedOidcConfig;
}

// ---------------------------------------------------------------------------
// PKCE helpers (Web Crypto)
// ---------------------------------------------------------------------------
function base64url(buffer: Uint8Array): string {
  const base64 = btoa(String.fromCharCode(...buffer));
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function generateCodeVerifier(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64url(bytes);
}

async function generateCodeChallenge(verifier: string): Promise<string> {
  const data = new TextEncoder().encode(verifier);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return base64url(new Uint8Array(hash));
}

function generateState(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return base64url(bytes);
}

/**
 * Builds the URL the browser is sent back to after adopting a device.
 *
 * The ID token is emitted twice, under two names. `oidcIdToken` is the current
 * name; `oidcGoogle` is the legacy one the device UI still reads
 * (ui/src/routes/adopt.tsx), which then POSTs it to the device's own
 * /cloud/register. Sending only `oidcIdToken` leaves that field null and the
 * device answers 400 {"error":"Invalid OIDC token"}.
 */
export function buildAdoptReturnUrl(
  returnTo: string,
  params: {
    tempToken: string;
    deviceId: string;
    idToken: string;
    clientId: string;
  },
): string {
  const url = new URL(returnTo);
  url.searchParams.append("tempToken", params.tempToken);
  url.searchParams.append("deviceId", params.deviceId);
  url.searchParams.append("oidcIdToken", params.idToken);
  url.searchParams.append("oidcGoogle", params.idToken);
  url.searchParams.append("clientId", params.clientId);
  return url.toString();
}

// ---------------------------------------------------------------------------
// Route Handlers
// ---------------------------------------------------------------------------

interface LoginBody {
  deviceId?: string;
  returnTo?: string;
}

/**
 * Reads the login parameters from either a JSON body or a form submission.
 *
 * The legacy /oidc/google endpoint is targeted by a native <form method="POST">
 * in the UI, so it arrives urlencoded rather than as JSON. parseBody also yields
 * File values for multipart bodies; only strings are meaningful here.
 */
async function readLoginBody(c: Context<AppType>): Promise<LoginBody> {
  const contentType = c.req.header("content-type") ?? "";

  const raw: Record<string, unknown> = contentType.includes("application/json")
    ? await c.req.json().catch(() => ({}))
    : await c.req.parseBody().catch(() => ({}));

  const str = (value: unknown) =>
    typeof value === "string" && value.length > 0 ? value : undefined;

  return { deviceId: str(raw.deviceId), returnTo: str(raw.returnTo) };
}

/**
 * POST /oidc/login — initiate OIDC login flow.
 * Also mounted at POST /oidc/google, the legacy endpoint the default UI posts to.
 * Sets session state and redirects to the provider's authorization endpoint.
 */
export const Login = async (c: Context<AppType>) => {
  const body = await readLoginBody(c);

  const session = c.get("session");
  const config = await getOidcConfig(c.env.OIDC_ISSUER);

  // Generate CSRF state
  const csrf = generateState();
  session.csrf = csrf;
  session.deviceId = body.deviceId;
  session.returnTo = body.returnTo;

  // Generate PKCE
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = await generateCodeChallenge(codeVerifier);
  session.code_verifier = codeVerifier;

  c.set("session", session);

  const redirectUri = `${c.env.API_HOSTNAME}/oidc/callback`;

  const state = new URLSearchParams();
  state.set("csrf", csrf);

  const authUrl = new URL(config.authorization_endpoint);
  authUrl.searchParams.set("client_id", c.env.OIDC_CLIENT_ID);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", "openid email profile");
  authUrl.searchParams.set("state", state.toString());
  authUrl.searchParams.set("code_challenge", codeChallenge);
  authUrl.searchParams.set("code_challenge_method", "S256");

  return c.redirect(authUrl.toString());
};

/**
 * GET /oidc/callback_o — the real OIDC callback handler.
 * Exchanges the authorization code for tokens, creates user in DB.
 */
export const Callback = async (c: Context<AppType>) => {
  const config = await getOidcConfig(c.env.OIDC_ISSUER);
  const session = c.get("session");
  const prisma = c.get("prisma");

  const url = new URL(c.req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  if (!code) {
    throw new BadRequestError(
      "Missing callback parameters",
      "missing_callback_params",
    );
  }

  const sessionCsrf = session.csrf;
  if (!sessionCsrf) {
    throw new BadRequestError("Missing CSRF in session", "missing_csrf");
  }

  const thisRequestCsrf = state
    ? new URLSearchParams(state).get("csrf")
    : null;
  if (thisRequestCsrf !== sessionCsrf) {
    throw new BadRequestError("Invalid CSRF", "invalid_csrf");
  }

  const deviceId = session.deviceId;
  const returnTo = session.returnTo ?? `${c.env.APP_HOSTNAME}/devices`;

  // Clear temporary session data
  session.csrf = undefined;
  session.returnTo = undefined;
  session.deviceId = undefined;

  const redirectUri = `${c.env.API_HOSTNAME}/oidc/callback`;

  // Exchange code for tokens
  const tokenResp = await fetch(config.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: c.env.OIDC_CLIENT_ID,
      client_secret: c.env.OIDC_CLIENT_SECRET,
      code_verifier: session.code_verifier || "",
    }),
  });

  if (!tokenResp.ok) {
    const errorBody = await tokenResp.text();
    console.error("Token exchange failed:", errorBody);
    throw new BadRequestError("Token exchange failed", "token_exchange_failed");
  }

  const tokenSet = (await tokenResp.json()) as {
    id_token?: string;
    access_token?: string;
  };

  if (!tokenSet.id_token) {
    throw new BadRequestError("Missing ID Token", "missing_id_token");
  }

  // Get user info
  const userinfoResp = await fetch(config.userinfo_endpoint, {
    headers: { Authorization: `Bearer ${tokenSet.access_token}` },
  });

  const userInfo = (await userinfoResp.json()) as {
    sub?: string;
    email?: string;
    picture?: string;
  };

  if (!userInfo.email) {
    c.set("session", {} as any);
    throw new BadRequestError(
      "Missing email claim in user info",
      "missing_email_claim",
    );
  }

  const allowedIdentities = getAllowedIdentities(c.env.ALLOWED_IDENTITIES);
  if (!isIdentityAllowed(userInfo.email, allowedIdentities)) {
    c.set("session", {} as any);
    throw new UnauthorizedError(
      "Account is not in the allowlist",
      "account_not_allowed",
    );
  }

  // Decode token claims
  const [, payloadB64] = tokenSet.id_token.split(".");
  const claimsJson = new TextDecoder().decode(
    Uint8Array.from(
      atob(payloadB64.replace(/-/g, "+").replace(/_/g, "/")),
      (ch) => ch.charCodeAt(0),
    ),
  );
  const tokenClaims = JSON.parse(claimsJson) as { sub: string };

  session.id_token = tokenSet.id_token;
  session.code_verifier = undefined;
  c.set("session", session);

  await prisma.user.upsert({
    where: { oidcId: tokenClaims.sub },
    update: {
      oidcId: tokenClaims.sub,
      email: userInfo.email,
      picture: userInfo.picture,
    },
    create: {
      oidcId: tokenClaims.sub,
      email: userInfo.email,
      picture: userInfo.picture,
    },
  });

  // Handle device adoption flow
  if (deviceId) {
    const deviceAdopted = await prisma.device.findUnique({
      where: { id: deviceId },
      select: { user: { select: { oidcId: true } } },
    });

    const isAdoptedByCurrentUser =
      deviceAdopted?.user.oidcId === tokenClaims.sub;
    const isAdoptedByOther = deviceAdopted && !isAdoptedByCurrentUser;

    if (isAdoptedByOther) {
      return c.redirect(`${c.env.APP_HOSTNAME}/already-adopted`);
    }

    const tempToken = randomHex(20);
    const tempTokenExpiresAt = new Date(Date.now() + 5 * 60000);

    await prisma.user.update({
      where: { oidcId: tokenClaims.sub },
      data: {
        device: {
          upsert: {
            create: { id: deviceId, tempToken, tempTokenExpiresAt },
            where: { id: deviceId },
            update: { tempToken, tempTokenExpiresAt },
          },
        },
      },
    });

    console.log("Adopted device", deviceId, "for user", tokenClaims.sub);

    const returnUrl = buildAdoptReturnUrl(returnTo, {
      tempToken,
      deviceId,
      idToken: tokenSet.id_token,
      clientId: c.env.OIDC_CLIENT_ID,
    });
    return c.redirect(returnUrl);
  }

  return c.redirect(returnTo);
};

/**
 * GET /oidc/callback — intermediate redirect to work around
 * SameSite=Strict cookie restrictions on OIDC redirects.
 */
export const CallbackIntermediate = (c: Context<AppType>) => {
  const url = new URL(c.req.url);
  const callbackUrl =
    url.pathname.replace("/oidc/callback", "/oidc/callback_o") +
    url.search;

  return c.html(
    `<html>
      <head>
        <meta http-equiv="refresh" content="0; URL='${callbackUrl}'"/>
        <script>
          document.documentElement.classList.toggle(
            "dark",
            localStorage.theme === "dark" ||
              (!("theme" in localStorage) &&
                window.matchMedia("(prefers-color-scheme: dark)").matches),
          );
          window
            .matchMedia("(prefers-color-scheme: dark)")
            .addEventListener("change", ({ matches }) => {
              if (!("theme" in localStorage)) {
                document.documentElement.classList.toggle("dark", matches);
              }
            });
        </script>
        <style>
          body {background-color: #0f172a;}
        </style>
      </head>
      <body></body>
    </html>`,
  );
};

