import * as jose from "jose";
import type { Context } from "hono";
import type { AppType } from "./env";
import {
  BadRequestError,
  NotFoundError,
  UnauthorizedError,
  UnprocessableEntityError,
} from "./errors";
import { randomHex } from "./helpers";
import { verifyToken } from "./auth";

/**
 * Helper to get device status (online/version) from its Durable Object.
 */
async function getDeviceStatus(
  env: AppType["Bindings"],
  deviceId: string,
): Promise<{ online: boolean; version: string | null }> {
  const doId = env.DEVICE_SIGNALING.idFromName(deviceId);
  const stub = env.DEVICE_SIGNALING.get(doId);
  const resp = await stub.fetch(new Request("https://do/status"));
  return resp.json() as Promise<{ online: boolean; version: string | null }>;
}

export const List = async (c: Context<AppType>) => {
  const session = c.get("session");
  const prisma = c.get("prisma");
  const idToken = session.id_token!;
  const { sub } = jose.decodeJwt(idToken);

  const devices = await prisma.device.findMany({
    where: { user: { oidcId: sub } },
    select: { id: true, name: true, lastSeen: true },
  });

  // Query status for each device from its Durable Object
  const devicesWithStatus = await Promise.all(
    devices.map(async (device: any) => {
      try {
        const status = await getDeviceStatus(c.env, device.id);
        return {
          ...device,
          online: status.online,
          version: status.version,
        };
      } catch {
        return { ...device, online: false, version: null };
      }
    }),
  );

  return c.json({ devices: devicesWithStatus });
};

export const Retrieve = async (c: Context<AppType>) => {
  const session = c.get("session");
  const prisma = c.get("prisma");
  const idToken = session.id_token!;
  const { sub } = jose.decodeJwt(idToken);
  const id = c.req.param("id");
  if (!id) throw new UnprocessableEntityError("Missing device id in params");

  const device = await prisma.device.findUnique({
    where: { id, user: { oidcId: sub } },
    select: { id: true, name: true, user: { select: { oidcId: true } } },
  });

  if (!device) throw new NotFoundError("Device not found");
  return c.json({ device });
};

export const Update = async (c: Context<AppType>) => {
  const session = c.get("session");
  const prisma = c.get("prisma");
  const idToken = session.id_token!;
  const { sub } = jose.decodeJwt(idToken);
  if (!sub) throw new UnauthorizedError("Missing sub in token");

  const id = c.req.param("id");
  if (!id) throw new UnprocessableEntityError("Missing device id in params");

  const body = await c.req.json();
  const { name } = body as { name: string };
  if (!name) throw new UnprocessableEntityError("Missing name in body");

  const device = await prisma.device.update({
    where: { id, user: { oidcId: sub } },
    data: { name },
    select: { id: true },
  });

  return c.json(device);
};

export const Token = async (c: Context<AppType>) => {
  const prisma = c.get("prisma");
  const body = await c.req.json();
  const { tempToken } = body as { tempToken: string };
  if (!tempToken)
    throw new UnprocessableEntityError("Missing temp token in body");

  const device = await prisma.device.findFirst({ where: { tempToken } });
  if (!device?.tempToken) throw new NotFoundError("Device not found");
  if ((device?.tempTokenExpiresAt || 0) < new Date())
    throw new UnauthorizedError("Token expired");

  const secretToken = randomHex(20);

  await prisma.device.update({
    where: { id: device.id },
    data: { secretToken, tempToken: null, tempTokenExpiresAt: null },
  });

  return c.json({ secretToken });
};

export const Delete = async (c: Context<AppType>) => {
  const prisma = c.get("prisma");

  const authHeader = c.req.header("Authorization");
  if (authHeader?.startsWith("Bearer ")) {
    const secretToken = authHeader.split("Bearer ")[1];

    const hasDevice = await prisma.device.findUnique({
      where: { secretToken },
    });
    if (!hasDevice) throw new NotFoundError("Device not found");

    await prisma.device.delete({ where: { secretToken } });
    return c.body(null, 204);
  }

  // If the user doesn't have a secret token, verify session auth
  const session = c.get("session");
  const idToken = session?.id_token;
  if (!idToken) throw new BadRequestError("Unauthorized");

  const payload = await verifyToken(idToken, c.env.OIDC_ISSUER, c.env.OIDC_CLIENT_ID);
  if (!payload) throw new BadRequestError("Unauthorized");

  const { sub } = jose.decodeJwt(idToken);
  if (!sub) throw new UnauthorizedError("Missing sub in token");

  const id = c.req.param("id");
  if (!id) throw new UnprocessableEntityError("Missing device id in params");

  await prisma.device.delete({ where: { id, user: { oidcId: sub } } });

  // Disconnect the device via its Durable Object
  try {
    const doId = c.env.DEVICE_SIGNALING.idFromName(id);
    const stub = c.env.DEVICE_SIGNALING.get(doId);
    await stub.fetch(new Request("https://do/disconnect", { method: "POST" }));
  } catch {
    // Device might not be connected, that's fine
  }

  return c.body(null, 204);
};
