import * as jose from "jose";
import type { Context } from "hono";
import type { AppType } from "./env";
import { NotFoundError, UnprocessableEntityError } from "./errors";

/**
 * Create a WebRTC session by forwarding SDP offer to the device via its Durable Object.
 */
export const CreateSession = async (c: Context<AppType>) => {
  const session = c.get("session");
  const prisma = c.get("prisma");
  const idToken = session.id_token!;
  const { sub } = jose.decodeJwt(idToken);

  const body = await c.req.json();
  const { id, sd } = body as { id?: string; sd?: string };

  if (!id) throw new UnprocessableEntityError("Missing id");
  if (!sd) throw new UnprocessableEntityError("Missing sd");

  const device = await prisma.device.findUnique({
    where: { id, user: { oidcId: sub } },
    select: { id: true },
  });

  if (!device) {
    throw new NotFoundError("Device not found");
  }

  // Forward the SDP offer to the device's Durable Object
  const doId = c.env.DEVICE_SIGNALING.idFromName(id);
  const stub = c.env.DEVICE_SIGNALING.get(doId);

  const resp = await stub.fetch(
    new Request("https://do/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sd,
        OidcToken: idToken,
      }),
    }),
  );

  if (!resp.ok) {
    const data = (await resp.json()) as { error?: string; code?: string };
    if (resp.status === 404) {
      throw new NotFoundError(
        data.error || "No socket for id found",
        data.code || "kvm_socket_not_found",
      );
    }
    return c.json(
      { error: data.error || "There was an error sending and receiving data to the KVM" },
      500,
    );
  }

  const data = await resp.json();
  return c.json(data);
};

/**
 * Create ICE credentials using Cloudflare TURN service.
 */
export const CreateIceCredentials = async (c: Context<AppType>) => {
  const resp = await fetch(
    `https://rtc.live.cloudflare.com/v1/turn/keys/${c.env.CLOUDFLARE_TURN_ID}/credentials/generate`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${c.env.CLOUDFLARE_TURN_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ttl: 3600 }),
    },
  );

  const data = (await resp.json()) as {
    iceServers: { credential?: string; urls: string | string[]; username?: string };
  };

  if (!data.iceServers.urls) {
    throw new Error("No ice servers returned");
  }

  if (data.iceServers.urls instanceof Array) {
    data.iceServers.urls = data.iceServers.urls.filter((url) => !url.startsWith("turns"));
  }

  return c.json(data);
};

/**
 * Record TURN activity for billing/usage tracking.
 */
export const CreateTurnActivity = async (c: Context<AppType>) => {
  const session = c.get("session");
  const prisma = c.get("prisma");
  const idToken = session.id_token!;
  const { sub } = jose.decodeJwt(idToken);

  const body = await c.req.json();
  const { bytesReceived, bytesSent } = body as {
    bytesReceived: number;
    bytesSent: number;
  };

  await prisma.turnActivity.create({
    data: {
      bytesReceived,
      bytesSent,
      user: { connect: { oidcId: sub } },
    },
  });

  return c.json({ success: true });
};
