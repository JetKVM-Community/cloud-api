import { Hono } from "hono";
import { cors } from "hono/cors";
import * as jose from "jose";

import type { AppType } from "./env";
import { createPrisma } from "./db";
import { sessionMiddleware } from "./session";
import { authenticated } from "./auth";
import { HttpError } from "./errors";

import * as Devices from "./devices";
import * as OIDC from "./oidc";
import * as Webrtc from "./webrtc";
import * as Releases from "./releases";
import { redfishRouter } from "./redfish";

// Re-export the Durable Object so wrangler can discover it
export { DeviceSignaling } from "./signaling";

const app = new Hono<AppType>();

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

// CORS
app.use(
  "*",
  async (c, next) => {
    const origins = c.env.CORS_ORIGINS?.split(",") || [
      "https://app.jetkvm.com",
      "http://localhost:5173",
    ];
    return cors({
      origin: origins,
      credentials: true,
    })(c, next);
  },
);

// Session (cookie-based, signed with HMAC-SHA256)
app.use("*", sessionMiddleware());

// Per-request Prisma client backed by D1
app.use("*", async (c, next) => {
  const prisma = createPrisma(c.env.DB);
  c.set("prisma", prisma);
  await next();
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

app.get("/", (c) => c.text("OK"));

app.get("/healthz", (c) =>
  c.json({ ready: true, time: new Date().toISOString() }),
);

app.get("/me", authenticated, async (c) => {
  const session = c.get("session");
  const prisma = c.get("prisma");
  const idToken = session.id_token!;
  const { sub } = jose.decodeJwt(idToken);

  const user = await prisma.user.findUnique({
    where: { oidcId: sub },
    select: { picture: true, email: true },
  });

  return c.json({ ...user, sub });
});

// Redfish compatibility layer
app.route("/redfish", redfishRouter);

// Releases
app.get("/releases", Releases.Retrieve);
app.get("/releases/system_recovery/latest", Releases.RetrieveLatestSystemRecovery);
app.get("/releases/app/latest", Releases.RetrieveLatestApp);

// Devices
app.get("/devices", authenticated, Devices.List);
app.get("/devices/:id", authenticated, Devices.Retrieve);
app.post("/devices/token", Devices.Token);
app.put("/devices/:id", authenticated, Devices.Update);
app.delete("/devices/:id", Devices.Delete);

// WebRTC
app.post("/webrtc/session", authenticated, Webrtc.CreateSession);
app.post("/webrtc/ice_config", authenticated, Webrtc.CreateIceCredentials);
app.post("/webrtc/turn_activity", authenticated, Webrtc.CreateTurnActivity);

// OIDC
app.post("/oidc/login", OIDC.Login);
app.get("/oidc/callback_o", OIDC.Callback);
app.get("/oidc/callback", OIDC.CallbackIntermediate);

// Logout
app.post("/logout", (c) => {
  c.set("session", null as any);
  return c.json({ message: "Logged out" });
});

// ---------------------------------------------------------------------------
// WebSocket upgrade routes (device + client signaling via Durable Object)
// ---------------------------------------------------------------------------

/**
 * Device WebSocket registration.
 * Devices connect here with Authorization header.
 * The request is upgraded and forwarded to the device's Durable Object.
 */
app.get("/ws/device", async (c) => {
  const upgradeHeader = c.req.header("Upgrade");
  if (!upgradeHeader || upgradeHeader.toLowerCase() !== "websocket") {
    return c.text("WebSocket upgrade required", 426);
  }

  const prisma = c.get("prisma");

  // Authenticate device
  const authHeader = c.req.header("Authorization");
  const secretToken = authHeader?.split(" ")?.[1];
  if (!secretToken) {
    return c.text("Unauthorized", 401);
  }

  const deviceId = c.req.header("X-Device-Id");
  if (!deviceId) {
    return c.text("Missing device ID", 400);
  }

  const device = await prisma.device.findFirst({
    where: { id: deviceId, secretToken },
  });
  if (!device) {
    return c.text("Invalid credentials", 401);
  }

  // Forward upgrade to the Durable Object
  const doId = c.env.DEVICE_SIGNALING.idFromName(device.id);
  const stub = c.env.DEVICE_SIGNALING.get(doId);

  const doReq = new Request("https://do/connect/device", {
    headers: {
      Upgrade: "websocket",
      "CF-Connecting-IP": c.req.header("CF-Connecting-IP") || c.req.header("X-Real-IP") || "",
      "X-App-Version": c.req.header("X-App-Version") || "",
    },
  });

  return stub.fetch(doReq);
});

/**
 * Client WebSocket signaling.
 * Authenticated clients connect here to perform WebRTC signaling with a device.
 */
app.get("/webrtc/signaling/client", async (c) => {
  const upgradeHeader = c.req.header("Upgrade");
  if (!upgradeHeader || upgradeHeader.toLowerCase() !== "websocket") {
    return c.text("WebSocket upgrade required", 426);
  }

  const session = c.get("session");
  const prisma = c.get("prisma");
  const idToken = session?.id_token;
  if (!idToken) {
    return c.text("Unauthorized", 401);
  }

  const { sub } = jose.decodeJwt(idToken);
  const deviceId = c.req.query("id");
  if (!deviceId) {
    return c.text("Missing device ID", 400);
  }

  // Verify device ownership
  const device = await prisma.device.findUnique({
    where: { id: deviceId, user: { oidcId: sub } },
    select: { id: true },
  });
  if (!device) {
    return c.text("Device not found", 404);
  }

  // Forward upgrade to the Durable Object
  const doId = c.env.DEVICE_SIGNALING.idFromName(deviceId);
  const stub = c.env.DEVICE_SIGNALING.get(doId);

  const doReq = new Request("https://do/connect/client", {
    headers: { Upgrade: "websocket" },
  });

  return stub.fetch(doReq);
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------
app.onError((err, c) => {
  const statusCode = err instanceof HttpError ? err.status : 500;
  console.error(err);
  return c.json(
    {
      name: err.name,
      message: err.message,
    },
    statusCode as any,
  );
});

export default app;
