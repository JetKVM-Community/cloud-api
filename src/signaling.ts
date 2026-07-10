import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";
import { createPrisma } from "./db";

/**
 * Durable Object that manages WebSocket connections for a single device.
 *
 * Each device gets its own DO instance, identified by device ID.
 * The DO handles:
 * - Device WebSocket registration (persistent connection from JetKVM hardware)
 * - Client WebSocket connections (browser-based signaling)
 * - WebRTC session creation (HTTP-based SDP exchange)
 * - JsonRPC command forwarding to the device
 */
export class DeviceSignaling extends DurableObject<Env> {
  /**
   * Pending session resolvers: keyed by a unique request ID.
   * When a client sends an SDP offer via HTTP, we forward it to the device WS
   * and wait for the device to respond. The response is resolved via this map.
   */
  private pendingSessionResolvers: Map<
    string,
    { resolve: (v: string) => void; reject: (e: Error) => void }
  > = new Map();

  /**
   * Pending JsonRPC resolvers: keyed by RPC id.
   */
  private pendingRpcResolvers: Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  > = new Map();

  private rpcIdCounter = 0;

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    switch (url.pathname) {
      case "/connect/device":
        return this.handleDeviceUpgrade(request);
      case "/connect/client":
        return this.handleClientUpgrade(request);
      case "/session":
        return this.handleSession(request);
      case "/status":
        return this.handleStatus();
      case "/command":
        return this.handleCommand(request);
      case "/jsonrpc":
        return this.handleJsonRpc(request);
      case "/disconnect":
        return this.handleDisconnect();
      default:
        return new Response("Not Found", { status: 404 });
    }
  }

  // ====================================================================
  // Device WebSocket
  // ====================================================================
  private async handleDeviceUpgrade(request: Request): Promise<Response> {
    // Close existing device connections
    const existingDeviceSockets = this.ctx.getWebSockets("device");
    for (const ws of existingDeviceSockets) {
      ws.close(1000, "New device connection replacing existing");
    }

    // Wait briefly for existing connections to flush
    if (existingDeviceSockets.length > 0) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    const ip =
      request.headers.get("CF-Connecting-IP") ||
      request.headers.get("X-Real-IP") ||
      "unknown";
    const version = request.headers.get("X-App-Version") || null;

    // Store device metadata
    await this.ctx.storage.put("deviceIp", ip);
    await this.ctx.storage.put("deviceVersion", version);
    await this.ctx.storage.put("online", true);

    this.ctx.acceptWebSocket(server, ["device"]);

    console.log(
      `[Device] New connection, version ${version || "unknown"}, ip ${ip}`,
    );

    return new Response(null, { status: 101, webSocket: client });
  }

  // ====================================================================
  // Client WebSocket
  // ====================================================================
  private async handleClientUpgrade(request: Request): Promise<Response> {
    const deviceSockets = this.ctx.getWebSockets("device");
    if (deviceSockets.length === 0) {
      return Response.json(
        { error: "Device not connected" },
        { status: 404 },
      );
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.ctx.acceptWebSocket(server, ["client"]);

    // Persist the authenticated client's OIDC token on the socket so it survives
    // hibernation and can be stamped onto SDP offers relayed to the device. The
    // Worker passes it via X-Oidc-Token (see index.ts). The device re-verifies
    // it against Google on every cloud session and won't answer without it.
    const oidcToken = request.headers.get("X-Oidc-Token");
    if (oidcToken) {
      server.serializeAttachment({ oidcToken });
    }

    // Send device metadata to client
    const version = await this.ctx.storage.get("deviceVersion");
    server.send(
      JSON.stringify({
        type: "device-metadata",
        data: { deviceVersion: version },
      }),
    );

    console.log("[Client] New WebSocket connection");

    return new Response(null, { status: 101, webSocket: client });
  }

  // ====================================================================
  // WebRTC Session Creation (HTTP-based SDP exchange)
  // ====================================================================
  private async handleSession(request: Request): Promise<Response> {
    const deviceSockets = this.ctx.getWebSockets("device");
    if (deviceSockets.length === 0) {
      return Response.json(
        { error: "No socket for id found", code: "kvm_socket_not_found" },
        { status: 404 },
      );
    }

    const body = (await request.json()) as {
      sd: string;
      OidcToken?: string;
    };

    const ip = (await this.ctx.storage.get<string>("deviceIp")) || "unknown";
    const iceServers = this.getIceServers();
    const deviceWs = deviceSockets[0];

    // Create a unique request ID for this session
    const requestId = crypto.randomUUID();

    try {
      const resp = await new Promise<string>((resolve, reject) => {
        const timeout = setTimeout(() => {
          this.pendingSessionResolvers.delete(requestId);
          reject(new Error("Timeout waiting for response from device"));
        }, 15000);

        this.pendingSessionResolvers.set(requestId, {
          resolve: (v: string) => {
            clearTimeout(timeout);
            this.pendingSessionResolvers.delete(requestId);
            resolve(v);
          },
          reject: (e: Error) => {
            clearTimeout(timeout);
            this.pendingSessionResolvers.delete(requestId);
            reject(e);
          },
        });

        deviceWs.send(
          JSON.stringify({
            sd: body.sd,
            ip,
            iceServers,
            OidcGoogle: body.OidcToken,
          }),
        );
      });

      return Response.json(JSON.parse(resp));
    } catch (e) {
      console.error("[Session] Error:", e);
      return Response.json(
        { error: "There was an error sending and receiving data to the KVM" },
        { status: 500 },
      );
    }
  }

  // ====================================================================
  // Status — check if device is online
  // ====================================================================
  private async handleStatus(): Promise<Response> {
    const deviceSockets = this.ctx.getWebSockets("device");
    const isOnline = deviceSockets.length > 0;
    const version = await this.ctx.storage.get("deviceVersion");
    return Response.json({ online: isOnline, version: version || null });
  }

  // ====================================================================
  // Command — send a message to device WS (keyboard, virtual-media, etc.)
  // ====================================================================
  private async handleCommand(request: Request): Promise<Response> {
    const deviceSockets = this.ctx.getWebSockets("device");
    if (deviceSockets.length === 0) {
      return Response.json(
        { error: "Device is not connected" },
        { status: 404 },
      );
    }

    const body = await request.text();
    deviceSockets[0].send(body);
    return new Response(null, { status: 204 });
  }

  // ====================================================================
  // JsonRPC — send RPC command and wait for response
  // ====================================================================
  private async handleJsonRpc(request: Request): Promise<Response> {
    const deviceSockets = this.ctx.getWebSockets("device");
    if (deviceSockets.length === 0) {
      return Response.json(
        { error: "Device is not connected" },
        { status: 404 },
      );
    }

    const { method, params, timeoutMs } = (await request.json()) as {
      method: string;
      params: Record<string, unknown>;
      timeoutMs?: number;
    };

    const id = ++this.rpcIdCounter;
    const timeout = timeoutMs || 10000;

    try {
      const result = await new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pendingRpcResolvers.delete(id);
          reject(
            new Error(`JsonRPC timeout waiting for response to ${method}`),
          );
        }, timeout);

        this.pendingRpcResolvers.set(id, {
          resolve: (v: unknown) => {
            clearTimeout(timer);
            this.pendingRpcResolvers.delete(id);
            resolve(v);
          },
          reject: (e: Error) => {
            clearTimeout(timer);
            this.pendingRpcResolvers.delete(id);
            reject(e);
          },
        });

        deviceSockets[0].send(
          JSON.stringify({
            type: "jsonrpc",
            data: { jsonrpc: "2.0", method, params, id },
          }),
        );
      });

      return Response.json({ result });
    } catch (e: any) {
      return Response.json({ error: e.message }, { status: 500 });
    }
  }

  // ====================================================================
  // Disconnect — force-close device connection
  // ====================================================================
  private handleDisconnect(): Response {
    const deviceSockets = this.ctx.getWebSockets("device");
    for (const ws of deviceSockets) {
      ws.send("Deregistered from server");
      ws.close(1000, "Deregistered");
    }
    const clientSockets = this.ctx.getWebSockets("client");
    for (const ws of clientSockets) {
      ws.close(1000, "Device deregistered");
    }
    return new Response(null, { status: 204 });
  }

  // ====================================================================
  // Hibernatable WebSocket handlers
  // ====================================================================
  async webSocketMessage(
    ws: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    const tags = this.ctx.getTags(ws);
    const msgStr =
      typeof message === "string"
        ? message
        : new TextDecoder().decode(message);

    if (tags.includes("device")) {
      this.handleDeviceMessage(msgStr);
    } else if (tags.includes("client")) {
      this.handleClientMessage(ws, msgStr);
    }
  }

  async webSocketClose(
    ws: WebSocket,
    code: number,
    reason: string,
    _wasClean: boolean,
  ): Promise<void> {
    const tags = this.ctx.getTags(ws);

    if (tags.includes("device")) {
      console.log(
        `[Device] Connection closed, code=${code}, reason=${reason}`,
      );
      await this.ctx.storage.put("online", false);

      // Close all client connections
      const clientSockets = this.ctx.getWebSockets("client");
      for (const client of clientSockets) {
        client.close(1000, "Device disconnected");
      }

      // Reject any pending session/rpc resolvers
      for (const [, resolver] of this.pendingSessionResolvers) {
        resolver.reject(new Error("Device disconnected"));
      }
      this.pendingSessionResolvers.clear();

      for (const [, resolver] of this.pendingRpcResolvers) {
        resolver.reject(new Error("Device disconnected"));
      }
      this.pendingRpcResolvers.clear();

      // Update lastSeen
      try {
        const deviceId = await this.ctx.storage.get<string>("deviceId");
        if (deviceId) {
          const prisma = createPrisma(this.env.DB);
          await prisma.device.update({
            where: { id: deviceId },
            data: { lastSeen: new Date() },
          });
        }
      } catch (e) {
        console.error("[Device] Error updating lastSeen:", e);
      }
    }

    if (tags.includes("client")) {
      console.log(
        `[Client] Connection closed, code=${code}, reason=${reason}`,
      );
    }
  }

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    console.error("[WebSocket] Error:", error);
    ws.close(1011, "Internal error");
  }

  // ====================================================================
  // Private helpers
  // ====================================================================
  private handleDeviceMessage(msgStr: string): void {
    // Check if this is a JsonRPC response
    try {
      const msg = JSON.parse(msgStr);

      // Handle JsonRPC responses
      if (msg.type === "jsonrpc" || msg.jsonrpc === "2.0") {
        const rpcResp = msg.type === "jsonrpc" ? msg.data : msg;
        const resolver = this.pendingRpcResolvers.get(rpcResp.id);
        if (resolver) {
          if (rpcResp.error) {
            resolver.reject(
              new Error(
                `JsonRPC error: ${rpcResp.error.message || JSON.stringify(rpcResp.error)}`,
              ),
            );
          } else {
            resolver.resolve(rpcResp.result);
          }
          return;
        }
      }

      // Handle typed messages from device (answer, new-ice-candidate)
      if (msg.type === "answer" || msg.type === "new-ice-candidate") {
        // Forward to all client WebSockets
        const clientSockets = this.ctx.getWebSockets("client");
        for (const client of clientSockets) {
          client.send(msgStr);
        }
        return;
      }
    } catch {
      // Not JSON — might be a raw session response
    }

    // If we have a pending session resolver, resolve it with the raw message
    if (this.pendingSessionResolvers.size > 0) {
      const first = this.pendingSessionResolvers.entries().next().value;
      if (first) {
        first[1].resolve(msgStr);
        return;
      }
    }

    // Forward any other message to clients
    const clientSockets = this.ctx.getWebSockets("client");
    for (const client of clientSockets) {
      client.send(msgStr);
    }
  }

  private async handleClientMessage(
    clientWs: WebSocket,
    msgStr: string,
  ): Promise<void> {
    // Handle ping/pong
    if (msgStr === "ping") {
      clientWs.send("pong");
      return;
    }

    const deviceSockets = this.ctx.getWebSockets("device");
    if (deviceSockets.length === 0) return;

    const deviceWs = deviceSockets[0];
    const ip = (await this.ctx.storage.get<string>("deviceIp")) || "unknown";
    const iceServers = this.getIceServers();

    try {
      const msg = JSON.parse(msgStr);

      switch (msg.type) {
        case "offer": {
          // The browser sends only { sd }; the OIDC token comes from the socket
          // attachment set at upgrade (see handleClientUpgrade). Fall back to a
          // token in the message for any client that does send one.
          const attachment = clientWs.deserializeAttachment() as
            | { oidcToken?: string }
            | null;
          const oidcGoogle = msg.data?.oidcToken ?? attachment?.oidcToken;
          console.log("[Client] Sending offer to device");
          deviceWs.send(
            JSON.stringify({
              type: "offer",
              data: {
                sd: msg.data.sd,
                ip,
                iceServers,
                OidcGoogle: oidcGoogle,
              },
            }),
          );
          break;
        }

        case "new-ice-candidate":
          console.log("[Client] Sending ICE candidate to device");
          deviceWs.send(
            JSON.stringify({
              type: "new-ice-candidate",
              data: msg.data,
            }),
          );
          break;
      }
    } catch (error) {
      console.error("[Client] Error processing message:", error);
    }
  }

  private getIceServers(): string[] {
    const raw =
      this.env.ICE_SERVERS ||
      "stun:stun.cloudflare.com:3478,stun:stun.l.google.com:19302,stun:stun1.l.google.com:5349";
    return raw
      .split(",")
      .filter((url: string) => url.startsWith("stun:"));
  }
}
