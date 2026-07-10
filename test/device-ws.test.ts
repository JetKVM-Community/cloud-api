import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import type { AppType } from "../src/env";
import { handleDeviceWebSocket } from "../src/device-ws";

const WS_HEADERS = {
  Upgrade: "websocket",
  Connection: "Upgrade",
  "Sec-WebSocket-Version": "13",
  "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
};

// Stands in for the DO's 101 upgrade response, which node's Response constructor
// rejects (status must be 200–599). The Cloudflare runtime allows 101.
const DO_MARKER = 299;

// Mirrors src/index.ts: the device handler is mounted at "/" (behind an upgrade
// check, so plain GET / stays a health check) and at "/ws/device".
function makeApp(deviceRow: { id: string } | null) {
  const stubFetch = vi.fn(async () => new Response(null, { status: DO_MARKER }));
  const app = new Hono<AppType>();

  app.use("*", async (c, next) => {
    c.set("session", {});
    c.set("prisma", {
      device: { findFirst: vi.fn(async () => deviceRow) },
    } as never);
    c.env = {
      DEVICE_SIGNALING: {
        idFromName: () => "do-id",
        get: () => ({ fetch: stubFetch }),
      },
    } as never;
    await next();
  });

  app.get("/", (c) => {
    const up = c.req.header("Upgrade");
    if (up && up.toLowerCase() === "websocket") return handleDeviceWebSocket(c);
    return c.text("OK");
  });
  app.get("/ws/device", handleDeviceWebSocket);

  return { app, stubFetch };
}

describe("device WebSocket at the root path", () => {
  // The firmware dials wss://<cloud-url>/ with no path (cloud.go); before this
  // fix, "/" returned 200 "OK" and the device handshake never upgraded.
  it("forwards a root upgrade with valid credentials to the Durable Object", async () => {
    const { app, stubFetch } = makeApp({ id: "dev-1" });
    const res = await app.request(
      "https://api.example/",
      { headers: { ...WS_HEADERS, Authorization: "Bearer secret", "X-Device-Id": "dev-1" } },
      {} as never,
    );
    expect(res.status).toBe(DO_MARKER);
    expect(stubFetch).toHaveBeenCalledOnce();
  });

  it("still serves the plain health check on GET / without an upgrade", async () => {
    const { app } = makeApp(null);
    const res = await app.request("https://api.example/", {}, {} as never);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("OK");
  });

  it("rejects a root upgrade with no Authorization (401)", async () => {
    const { app } = makeApp(null);
    const res = await app.request("https://api.example/", { headers: WS_HEADERS }, {} as never);
    expect(res.status).toBe(401);
  });

  it("rejects a root upgrade missing X-Device-Id (400)", async () => {
    const { app } = makeApp(null);
    const res = await app.request(
      "https://api.example/",
      { headers: { ...WS_HEADERS, Authorization: "Bearer secret" } },
      {} as never,
    );
    expect(res.status).toBe(400);
  });

  it("rejects an unknown or mismatched secretToken (401)", async () => {
    const { app } = makeApp(null); // findFirst returns null
    const res = await app.request(
      "https://api.example/",
      { headers: { ...WS_HEADERS, Authorization: "Bearer bad", "X-Device-Id": "dev-1" } },
      {} as never,
    );
    expect(res.status).toBe(401);
  });

  it("keeps the legacy /ws/device path working", async () => {
    const { app, stubFetch } = makeApp({ id: "dev-1" });
    const res = await app.request(
      "https://api.example/ws/device",
      { headers: { ...WS_HEADERS, Authorization: "Bearer secret", "X-Device-Id": "dev-1" } },
      {} as never,
    );
    expect(res.status).toBe(DO_MARKER);
    expect(stubFetch).toHaveBeenCalledOnce();
  });

  it("returns 426 for /ws/device without an upgrade header", async () => {
    const { app } = makeApp(null);
    const res = await app.request("https://api.example/ws/device", {}, {} as never);
    expect(res.status).toBe(426);
  });
});
