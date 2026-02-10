import type { Env } from "./env";

/**
 * Send a JsonRPC 2.0 request to a device via its Durable Object.
 *
 * This replaces the direct WebSocket call from the Express version.
 * The Durable Object handles the actual WebSocket communication.
 */
export async function sendJsonRpc(
  env: Env,
  deviceId: string,
  method: string,
  params: Record<string, unknown>,
  timeoutMs = 10000,
): Promise<unknown> {
  const doId = env.DEVICE_SIGNALING.idFromName(deviceId);
  const stub = env.DEVICE_SIGNALING.get(doId);

  const resp = await stub.fetch(new Request("https://do/jsonrpc", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ method, params, timeoutMs }),
  }));

  const data = (await resp.json()) as {
    result?: unknown;
    error?: string;
  };

  if (!resp.ok || data.error) {
    throw new Error(data.error || `JsonRPC call failed: ${method}`);
  }

  return data.result;
}

