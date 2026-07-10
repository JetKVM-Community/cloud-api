import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import type { AppType } from "../src/env";
import { sessionMiddleware } from "../src/session";

const env = { COOKIE_SECRET: "test-secret" } as unknown as AppType["Bindings"];

function makeApp() {
  const app = new Hono<AppType>();
  app.use("*", sessionMiddleware());

  // Writes to the session, like POST /oidc/login.
  app.post("/login", (c) => {
    const session = c.get("session");
    session.csrf = "csrf-token";
    session.code_verifier = "verifier";
    c.set("session", session);
    return c.text("ok");
  });

  // Touches nothing, like GET /oidc/callback (the SameSite intermediate).
  app.get("/passthrough", (c) => c.html("<html></html>"));

  // Reads the session, like GET /oidc/callback_o.
  app.get("/read", (c) => c.json({ csrf: c.get("session").csrf ?? null }));

  // Clears the session, like POST /logout.
  app.post("/logout", (c) => {
    c.set("session", null as never);
    return c.text("bye");
  });

  return app;
}

function setCookies(res: Response): string[] {
  return res.headers.getSetCookie?.() ?? [];
}

function cookieHeaderFrom(res: Response): string {
  return setCookies(res)
    .map((c) => c.split(";")[0])
    .join("; ");
}

describe("sessionMiddleware", () => {
  it("writes signed session cookies when a handler populates the session", async () => {
    const res = await makeApp().request("https://api.example/login", { method: "POST" }, env);
    const cookies = setCookies(res);

    expect(cookies.some((c) => c.startsWith("session="))).toBe(true);
    expect(cookies.some((c) => c.startsWith("session.sig="))).toBe(true);
    expect(cookies[0]).toContain("SameSite=Strict");
  });

  it("round-trips a session back to a later request", async () => {
    const app = makeApp();
    const login = await app.request("https://api.example/login", { method: "POST" }, env);

    const res = await app.request(
      "https://api.example/read",
      { headers: { cookie: cookieHeaderFrom(login) } },
      env,
    );
    expect(await res.json()).toEqual({ csrf: "csrf-token" });
  });

  // The OIDC callback arrives as a cross-site navigation from the IdP, so the
  // SameSite=Strict cookie is withheld and the request sees an empty session.
  // Writing that empty session back would clobber the real cookie — destroying
  // the CSRF token that /oidc/callback_o is about to verify.
  it("does not emit cookies when no session came in and none was created", async () => {
    const res = await makeApp().request("https://api.example/passthrough", {}, env);
    expect(setCookies(res)).toEqual([]);
  });

  it("survives a cookie-less intermediate hop between login and read", async () => {
    const app = makeApp();
    const login = await app.request("https://api.example/login", { method: "POST" }, env);
    const stored = cookieHeaderFrom(login);

    // Cross-site hop: browser withholds the cookie.
    const intermediate = await app.request("https://api.example/passthrough", {}, env);
    expect(setCookies(intermediate)).toEqual([]);

    // Same-site hop: browser sends the cookie it still holds.
    const res = await app.request(
      "https://api.example/read",
      { headers: { cookie: stored } },
      env,
    );
    expect(await res.json()).toEqual({ csrf: "csrf-token" });
  });

  // NOTE: the WebSocket-upgrade passthrough (session middleware must not rebuild
  // a status-101 response, which would throw RangeError and 500 the client
  // signaling upgrade) cannot be unit-tested here: node's Response constructor
  // rejects status 101, so the precondition can't be built. That path is
  // verified live against the deployed Worker.

  it("still clears cookies on logout", async () => {
    const app = makeApp();
    const login = await app.request("https://api.example/login", { method: "POST" }, env);

    const res = await app.request(
      "https://api.example/logout",
      { method: "POST", headers: { cookie: cookieHeaderFrom(login) } },
      env,
    );
    const cookies = setCookies(res);
    expect(cookies).toHaveLength(2);
    expect(cookies.every((c) => c.includes("Max-Age=0"))).toBe(true);
  });

  it("overwrites a tampered session cookie rather than trusting it", async () => {
    const app = makeApp();
    const res = await app.request(
      "https://api.example/read",
      { headers: { cookie: "session=bogus; session.sig=bogus" } },
      env,
    );
    expect(await res.json()).toEqual({ csrf: null });
    expect(setCookies(res).length).toBeGreaterThan(0);
  });
});
