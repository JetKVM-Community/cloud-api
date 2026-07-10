import type { MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import type { AppType, SessionData } from "./env";

/**
 * HMAC-SHA256 sign a string with a secret key.
 */
async function sign(data: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(data),
  );
  return base64url(new Uint8Array(sig));
}

/**
 * Verify an HMAC-SHA256 signature.
 */
async function verify(
  data: string,
  signature: string,
  secret: string,
): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const sigBytes = base64urlDecode(signature);
  return crypto.subtle.verify(
    "HMAC",
    key,
    sigBytes,
    new TextEncoder().encode(data),
  );
}

function base64url(buffer: Uint8Array): string {
  const base64 = btoa(String.fromCharCode(...buffer));
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlDecode(str: string): Uint8Array {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/");
  const base64 = padded + "=".repeat((4 - (padded.length % 4)) % 4);
  const binary = atob(base64);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

function serializeSetCookie(
  name: string,
  value: string,
  opts: {
    path?: string;
    httpOnly?: boolean;
    secure?: boolean;
    sameSite?: "Strict" | "Lax" | "None";
    maxAge?: number;
  },
): string {
  let cookie = `${name}=${encodeURIComponent(value)}`;
  if (opts.path) cookie += `; Path=${opts.path}`;
  if (opts.httpOnly) cookie += "; HttpOnly";
  if (opts.secure) cookie += "; Secure";
  if (opts.sameSite) cookie += `; SameSite=${opts.sameSite}`;
  if (opts.maxAge !== undefined) cookie += `; Max-Age=${opts.maxAge}`;
  return cookie;
}

/**
 * Cookie session middleware for Hono on Cloudflare Workers.
 *
 * Reads and writes signed session data from cookies, replicating
 * the behavior of `cookie-session` in the Express version.
 *
 * Session data is stored as base64url-encoded JSON in a `session` cookie,
 * with an HMAC-SHA256 signature in `session.sig`.
 */
export function sessionMiddleware(): MiddlewareHandler<AppType> {
  return async (c, next) => {
    const cookieSecret = c.env.COOKIE_SECRET;

    // Read session from cookie
    const sessionCookie = getCookie(c, "session");
    const sigCookie = getCookie(c, "session.sig");
    const hadSessionCookie = Boolean(sessionCookie && sigCookie);

    let session: SessionData = {};

    if (sessionCookie && sigCookie) {
      try {
        const isValid = await verify(
          sessionCookie,
          sigCookie,
          cookieSecret,
        );
        if (isValid) {
          const decoded = new TextDecoder().decode(
            base64urlDecode(sessionCookie),
          );
          session = JSON.parse(decoded);
        }
      } catch {
        // Invalid session cookie, start with empty session
      }
    }

    c.set("session", session);

    await next();

    // A WebSocket upgrade (101) carries a `webSocket` and cannot be rebuilt:
    // `new Response(body, { status: 101 })` throws RangeError (valid range is
    // 200–599). Set-Cookie on a 101 is meaningless anyway, so leave it untouched.
    // The client signaling upgrade is authenticated by cookie and so reaches
    // here with a populated session; without this guard it 500s.
    if (c.res.status === 101 || c.res.webSocket) {
      return;
    }

    // After handler, write updated session to cookies
    const updatedSession = c.get("session");
    const cookieOpts = {
      path: "/",
      httpOnly: true,
      secure: true,
      sameSite: "Strict" as const,
      maxAge: 24 * 60 * 60, // 24 hours in seconds
    };

    if (updatedSession === null || updatedSession === undefined) {
      // Session cleared — set empty cookies with max-age 0
      const clearOpts = { ...cookieOpts, maxAge: 0 };
      const headers = new Headers(c.res.headers);
      headers.append("Set-Cookie", serializeSetCookie("session", "", clearOpts));
      headers.append(
        "Set-Cookie",
        serializeSetCookie("session.sig", "", clearOpts),
      );
      c.res = new Response(c.res.body, {
        status: c.res.status,
        statusText: c.res.statusText,
        headers,
      });
    } else if (!hadSessionCookie && Object.keys(updatedSession).length === 0) {
      // Nothing to persist, and nothing arrived. Do NOT write an empty session:
      // a cross-site navigation withholds the SameSite=Strict cookie, so a
      // session the browser still holds looks absent here. That is exactly what
      // GET /oidc/callback is — the hop back from the identity provider — and
      // writing `{}` would clobber the CSRF token that /oidc/callback_o then
      // fails to find. See CallbackIntermediate in oidc.ts.
      return;
    } else {
      const json = JSON.stringify(updatedSession);
      const encoded = base64url(new TextEncoder().encode(json));
      const sig = await sign(encoded, cookieSecret);

      const headers = new Headers(c.res.headers);
      headers.append(
        "Set-Cookie",
        serializeSetCookie("session", encoded, cookieOpts),
      );
      headers.append(
        "Set-Cookie",
        serializeSetCookie("session.sig", sig, cookieOpts),
      );
      c.res = new Response(c.res.body, {
        status: c.res.status,
        statusText: c.res.statusText,
        headers,
      });
    }
  };
}
