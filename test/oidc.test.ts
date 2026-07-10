import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { AppType, SessionData } from "../src/env";
import { Login, buildAdoptReturnUrl } from "../src/oidc";

const AUTHORIZATION_ENDPOINT = "https://issuer.example/authorize";

const env = {
  OIDC_ISSUER: "https://issuer.example",
  OIDC_CLIENT_ID: "client-123",
  API_HOSTNAME: "https://api.example",
} as unknown as AppType["Bindings"];

function makeApp(session: SessionData) {
  const app = new Hono<AppType>();
  app.use("*", async (c, next) => {
    c.set("session", session);
    await next();
  });
  // Mirrors src/index.ts: the legacy alias shares the Login handler.
  app.post("/oidc/login", Login);
  app.post("/oidc/google", Login);
  return app;
}

function formRequest(path: string, fields: Record<string, string>) {
  return new Request(`https://api.example${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  });
}

function jsonRequest(path: string, body: unknown) {
  return new Request(`https://api.example${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(
        JSON.stringify({
          authorization_endpoint: AUTHORIZATION_ENDPOINT,
          token_endpoint: "https://issuer.example/token",
          userinfo_endpoint: "https://issuer.example/userinfo",
        }),
        { headers: { "content-type": "application/json" } },
      ),
    ),
  );
});

describe("OIDC Login", () => {
  it("redirects to the authorization endpoint with PKCE", async () => {
    const session: SessionData = {};
    const res = await makeApp(session).request(jsonRequest("/oidc/login", {}), undefined, env);

    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location")!);
    expect(`${location.origin}${location.pathname}`).toBe(AUTHORIZATION_ENDPOINT);
    expect(location.searchParams.get("client_id")).toBe("client-123");
    expect(location.searchParams.get("redirect_uri")).toBe("https://api.example/oidc/callback");
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");
    expect(session.code_verifier).toBeTruthy();
    expect(session.csrf).toBeTruthy();
  });

  // The default UI submits <form action={`${CLOUD_API}/oidc/google`} method="POST">,
  // which arrives urlencoded rather than as JSON.
  it("accepts the legacy /oidc/google form post and keeps deviceId and returnTo", async () => {
    const session: SessionData = {};
    const res = await makeApp(session).request(
      formRequest("/oidc/google", { deviceId: "kvm-1", returnTo: "/devices/kvm-1" }),
      undefined,
      env,
    );

    expect(res.status).toBe(302);
    expect(session.deviceId).toBe("kvm-1");
    expect(session.returnTo).toBe("/devices/kvm-1");
  });

  it("accepts a form post on /oidc/login too", async () => {
    const session: SessionData = {};
    const res = await makeApp(session).request(
      formRequest("/oidc/login", { deviceId: "kvm-2", returnTo: "/devices/kvm-2" }),
      undefined,
      env,
    );

    expect(res.status).toBe(302);
    expect(session.deviceId).toBe("kvm-2");
    expect(session.returnTo).toBe("/devices/kvm-2");
  });

  it("still reads deviceId and returnTo from a JSON body", async () => {
    const session: SessionData = {};
    await makeApp(session).request(
      jsonRequest("/oidc/login", { deviceId: "kvm-3", returnTo: "/devices/kvm-3" }),
      undefined,
      env,
    );

    expect(session.deviceId).toBe("kvm-3");
    expect(session.returnTo).toBe("/devices/kvm-3");
  });

  it("leaves deviceId and returnTo undefined when the form omits them", async () => {
    const session: SessionData = {};
    const res = await makeApp(session).request(formRequest("/oidc/google", {}), undefined, env);

    expect(res.status).toBe(302);
    expect(session.deviceId).toBeUndefined();
    expect(session.returnTo).toBeUndefined();
  });
});

describe("buildAdoptReturnUrl", () => {
  const params = {
    tempToken: "temp-abc",
    deviceId: "kvm-1",
    idToken: "header.payload.signature",
    clientId: "client-123",
  };

  it("carries tempToken, deviceId and clientId through to the device UI", () => {
    const q = new URL(buildAdoptReturnUrl("http://10.0.0.5/adopt", params)).searchParams;

    expect(q.get("tempToken")).toBe("temp-abc");
    expect(q.get("deviceId")).toBe("kvm-1");
    expect(q.get("clientId")).toBe("client-123");
  });

  // adopt.tsx reads `oidcGoogle` and posts it to the device's /cloud/register.
  // Emitting only `oidcIdToken` sends null and the device answers
  // 400 {"error":"Invalid OIDC token"}.
  it("emits the ID token under both oidcIdToken and the legacy oidcGoogle", () => {
    const q = new URL(buildAdoptReturnUrl("http://10.0.0.5/adopt", params)).searchParams;

    expect(q.get("oidcIdToken")).toBe(params.idToken);
    expect(q.get("oidcGoogle")).toBe(params.idToken);
  });

  it("preserves an existing query string on returnTo", () => {
    const url = new URL(buildAdoptReturnUrl("http://10.0.0.5/adopt?foo=bar", params));

    expect(url.searchParams.get("foo")).toBe("bar");
    expect(url.searchParams.get("oidcGoogle")).toBe(params.idToken);
    expect(url.pathname).toBe("/adopt");
  });
});
