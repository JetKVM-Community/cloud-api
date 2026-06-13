import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { AppType, SessionData } from "../src/env";
import {
  getResetKeySequence,
  HID_KEY,
  HID_MODIFIER,
} from "../src/redfish-keys";

// ---------------------------------------------------------------------------
// Unit tests for redfish-keys.ts
// ---------------------------------------------------------------------------
describe("redfish-keys", () => {
  describe("HID_KEY constants", () => {
    it("should have correct function key codes", () => {
      expect(HID_KEY.F1).toBe(0x3a);
      expect(HID_KEY.F4).toBe(0x3d);
      expect(HID_KEY.F12).toBe(0x45);
    });

    it("should have correct special key codes", () => {
      expect(HID_KEY.RETURN).toBe(0x28);
      expect(HID_KEY.ESCAPE).toBe(0x29);
      expect(HID_KEY.DELETE).toBe(0x4c);
      expect(HID_KEY.POWER).toBe(0x66);
    });
  });

  describe("HID_MODIFIER constants", () => {
    it("should have correct modifier values", () => {
      expect(HID_MODIFIER.NONE).toBe(0x00);
      expect(HID_MODIFIER.LEFT_CTRL).toBe(0x01);
      expect(HID_MODIFIER.LEFT_ALT).toBe(0x04);
    });
  });

  describe("getResetKeySequence", () => {
    it("should return Ctrl+Alt+Delete for ForceRestart", () => {
      const seq = getResetKeySequence("ForceRestart");
      expect(seq).not.toBeNull();
      expect(seq).toHaveLength(1);
      expect(seq![0].modifier).toBe(
        HID_MODIFIER.LEFT_CTRL | HID_MODIFIER.LEFT_ALT,
      );
      expect(seq![0].keys).toContain(HID_KEY.DELETE);
    });

    it("should return Ctrl+Alt+Delete for GracefulRestart", () => {
      const seq = getResetKeySequence("GracefulRestart");
      expect(seq).not.toBeNull();
      expect(seq![0].modifier).toBe(
        HID_MODIFIER.LEFT_CTRL | HID_MODIFIER.LEFT_ALT,
      );
      expect(seq![0].keys).toContain(HID_KEY.DELETE);
    });

    it("should return Alt+F4 for GracefulShutdown", () => {
      const seq = getResetKeySequence("GracefulShutdown");
      expect(seq).not.toBeNull();
      expect(seq![0].modifier).toBe(HID_MODIFIER.LEFT_ALT);
      expect(seq![0].keys).toContain(HID_KEY.F4);
    });

    it("should return Power key for ForceOff", () => {
      const seq = getResetKeySequence("ForceOff");
      expect(seq).not.toBeNull();
      expect(seq![0].modifier).toBe(HID_MODIFIER.NONE);
      expect(seq![0].keys).toContain(HID_KEY.POWER);
    });

    it("should return Power key for On", () => {
      const seq = getResetKeySequence("On");
      expect(seq).not.toBeNull();
      expect(seq![0].modifier).toBe(HID_MODIFIER.NONE);
      expect(seq![0].keys).toContain(HID_KEY.POWER);
    });

    it("should return null for unsupported reset type", () => {
      expect(getResetKeySequence("InvalidType")).toBeNull();
      expect(getResetKeySequence("")).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// Redfish authentication middleware tests
// ---------------------------------------------------------------------------

import { redfishAuthenticated } from "../src/redfish";

function createRedfishTestApp(options: {
  session?: SessionData;
  mockPrisma?: any;
}) {
  const app = new Hono<AppType>();

  // Pre-set session & prisma
  app.use("*", async (c, next) => {
    c.set("session", (options.session || {}) as any);
    if (options.mockPrisma) {
      c.set("prisma", options.mockPrisma);
    }
    await next();
  });

  // Middleware under test
  app.use("*", redfishAuthenticated);

  // Test endpoint
  app.get("/test", (c) => {
    return c.json({ sub: c.get("redfishSub" as any) });
  });

  return app;
}

describe("redfishAuthenticated middleware", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should authenticate via session cookie when id_token is present", async () => {
    // Create a minimal valid JWT payload (not verified, just decoded)
    const header = btoa(JSON.stringify({ alg: "none" }))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
    const payload = btoa(JSON.stringify({ sub: "oidc-user-123" }))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
    const fakeToken = `${header}.${payload}.`;

    const app = createRedfishTestApp({
      session: { id_token: fakeToken },
    });

    const res = await app.request("/test");
    expect(res.status).toBe(200);

    const body = (await res.json()) as any;
    expect(body.sub).toBe("oidc-user-123");
  });

  it("should authenticate via Basic Auth with valid device credentials", async () => {
    const mockPrisma = {
      device: {
        findFirst: vi.fn().mockResolvedValueOnce({
          id: "device-123",
          secretToken: "secret-token-456",
          user: { oidcId: "oidc-user-789" },
        }),
      },
    };

    const credentials = btoa("device-123:secret-token-456");

    const app = createRedfishTestApp({ mockPrisma });
    const res = await app.request("/test", {
      headers: { Authorization: `Basic ${credentials}` },
    });

    expect(res.status).toBe(200);

    const body = (await res.json()) as any;
    expect(body.sub).toBe("oidc-user-789");
  });

  it("should reject invalid Basic Auth credentials", async () => {
    const mockPrisma = {
      device: {
        findFirst: vi.fn().mockResolvedValueOnce(null),
      },
    };

    const credentials = btoa("bad-device:bad-token");

    const app = createRedfishTestApp({ mockPrisma });
    const res = await app.request("/test", {
      headers: { Authorization: `Basic ${credentials}` },
    });

    expect(res.status).toBe(401);
  });

  it("should return 401 with WWW-Authenticate header when no auth provided", async () => {
    const app = createRedfishTestApp({});
    const res = await app.request("/test");

    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toBe(
      'Basic realm="JetKVM Redfish Service"',
    );
  });
});

// ---------------------------------------------------------------------------
// Unit tests for jsonrpc.ts (Durable Object based)
// ---------------------------------------------------------------------------

import { sendJsonRpc } from "../src/jsonrpc";

function createMockEnv(
  fetchHandler: (req: Request) => Promise<Response>,
): any {
  return {
    DEVICE_SIGNALING: {
      idFromName: vi.fn().mockReturnValue({ toString: () => "do-id" }),
      get: vi.fn().mockReturnValue({
        fetch: fetchHandler,
      }),
    },
  };
}

describe("sendJsonRpc", () => {
  it("should send a JsonRPC request and resolve with the result", async () => {
    const env = createMockEnv(async (req) => {
      const body = (await req.json()) as any;
      expect(body.method).toBe("getActiveExtension");
      expect(body.params).toEqual({});
      return new Response(JSON.stringify({ result: "dc-power" }));
    });

    const result = await sendJsonRpc(
      env,
      "device-123",
      "getActiveExtension",
      {},
    );
    expect(result).toBe("dc-power");

    // Verify DurableObject was looked up by device ID
    expect(env.DEVICE_SIGNALING.idFromName).toHaveBeenCalledWith(
      "device-123",
    );
  });

  it("should reject on JsonRPC error response", async () => {
    const env = createMockEnv(async () => {
      return new Response(
        JSON.stringify({ error: "Extension not loaded" }),
        { status: 500 },
      );
    });

    await expect(
      sendJsonRpc(env, "device-123", "getDCPowerState", {}),
    ).rejects.toThrow("Extension not loaded");
  });

  it("should pass timeout value in request body", async () => {
    let receivedTimeout: number | undefined;

    const env = createMockEnv(async (req) => {
      const body = (await req.json()) as any;
      receivedTimeout = body.timeoutMs;
      return new Response(JSON.stringify({ result: "ok" }));
    });

    await sendJsonRpc(env, "device-123", "test", {}, 50);
    expect(receivedTimeout).toBe(50);
  });

  it("should reject when response is not ok even without error field", async () => {
    const env = createMockEnv(async () => {
      return new Response(JSON.stringify({}), { status: 500 });
    });

    await expect(
      sendJsonRpc(env, "device-123", "failMethod", {}),
    ).rejects.toThrow("JsonRPC call failed: failMethod");
  });
});
