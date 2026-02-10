import { describe, it, expect, vi, beforeEach } from "vitest";
import { Request, Response } from "express";
import { getResetKeySequence, HID_KEY, HID_MODIFIER } from "../src/redfish-keys";

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
      expect(seq![0].modifier).toBe(HID_MODIFIER.LEFT_CTRL | HID_MODIFIER.LEFT_ALT);
      expect(seq![0].keys).toContain(HID_KEY.DELETE);
    });

    it("should return Ctrl+Alt+Delete for GracefulRestart", () => {
      const seq = getResetKeySequence("GracefulRestart");
      expect(seq).not.toBeNull();
      expect(seq![0].modifier).toBe(HID_MODIFIER.LEFT_CTRL | HID_MODIFIER.LEFT_ALT);
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
// Unit tests for redfish.ts route handlers
// ---------------------------------------------------------------------------

// We mock the dependencies to test route handlers in isolation
vi.mock("../src/db", () => ({
  prisma: {
    device: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
    },
  },
}));

vi.mock("../src/webrtc-signaling", () => ({
  activeConnections: new Map(),
}));

import { redfishAuthenticated } from "../src/redfish";
import { prisma } from "../src/db";
import { activeConnections } from "../src/webrtc-signaling";

function createMockRequest(overrides: Partial<Request> = {}): Request {
  return {
    session: {},
    headers: {},
    params: {},
    body: {},
    ...overrides,
  } as unknown as Request;
}

function createMockResponse() {
  const res: any = {
    _status: 200,
    _json: null,
    _headers: {} as Record<string, string>,
    status: vi.fn(function (this: any, code: number) {
      this._status = code;
      return this;
    }),
    json: vi.fn(function (this: any, data: any) {
      this._json = data;
      return this;
    }),
    set: vi.fn(function (this: any, key: string, value: string) {
      this._headers[key] = value;
      return this;
    }),
    send: vi.fn(function (this: any) {
      return this;
    }),
  };
  return res as Response & { _status: number; _json: any; _headers: Record<string, string> };
}

describe("redfishAuthenticated middleware", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should authenticate via session cookie when id_token is present", async () => {
    // Create a minimal valid JWT payload (not verified, just decoded)
    const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ sub: "google-user-123" })).toString("base64url");
    const fakeToken = `${header}.${payload}.`;

    const req = createMockRequest({
      session: { id_token: fakeToken },
    });
    const res = createMockResponse();
    const next = vi.fn();

    await redfishAuthenticated(req, res, next);

    expect(next).toHaveBeenCalled();
    expect((req as any).redfishSub).toBe("google-user-123");
  });

  it("should authenticate via Basic Auth with valid device credentials", async () => {
    const credentials = Buffer.from("device-123:secret-token-456").toString("base64");

    const req = createMockRequest({
      headers: { authorization: `Basic ${credentials}` } as any,
    });
    const res = createMockResponse();
    const next = vi.fn();

    vi.mocked(prisma.device.findFirst).mockResolvedValueOnce({
      id: "device-123",
      secretToken: "secret-token-456",
      user: { googleId: "google-user-789" },
    } as any);

    await redfishAuthenticated(req, res, next);

    expect(next).toHaveBeenCalled();
    expect((req as any).redfishSub).toBe("google-user-789");
  });

  it("should reject invalid Basic Auth credentials", async () => {
    const credentials = Buffer.from("bad-device:bad-token").toString("base64");

    const req = createMockRequest({
      headers: { authorization: `Basic ${credentials}` } as any,
    });
    const res = createMockResponse();
    const next = vi.fn();

    vi.mocked(prisma.device.findFirst).mockResolvedValueOnce(null);

    await redfishAuthenticated(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it("should return 401 with WWW-Authenticate header when no auth provided", async () => {
    const req = createMockRequest();
    const res = createMockResponse();
    const next = vi.fn();

    await redfishAuthenticated(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.set).toHaveBeenCalledWith(
      "WWW-Authenticate",
      'Basic realm="JetKVM Redfish Service"',
    );
  });
});
