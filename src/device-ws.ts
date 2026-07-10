import type { Context } from "hono";
import type { AppType } from "./env";

/**
 * Device WebSocket registration.
 *
 * Devices connect with an `Authorization: Bearer <secretToken>` header and an
 * `X-Device-Id` header; the upgrade is forwarded to the device's Durable Object.
 *
 * Mounted at both "/" and "/ws/device". The stock JetKVM firmware dials the
 * cloud URL's root with no path — see websocket.Dial(config.CloudURL) in the
 * device's cloud.go — so the root mount is what actually lets a device connect.
 */
export async function handleDeviceWebSocket(
  c: Context<AppType>,
): Promise<Response> {
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

  // Header lookup is case-insensitive; the firmware sends "X-Device-ID".
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
      "CF-Connecting-IP":
        c.req.header("CF-Connecting-IP") || c.req.header("X-Real-IP") || "",
      "X-App-Version": c.req.header("X-App-Version") || "",
    },
  });

  return stub.fetch(doReq);
}
