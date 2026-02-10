import { WebSocket } from "ws";

// JsonRPC 2.0 request/response types following the pattern from
// https://github.com/jetkvm/kvm/blob/dev/jsonrpc.go

interface JsonRpcRequest {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
  id: number;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
  id: number;
}

let rpcIdCounter = 0;

/**
 * Sends a JsonRPC 2.0 request to a device over its WebSocket connection
 * and waits for the response. The device WebSocket must support the
 * JsonRPC message format used by JetKVM firmware.
 *
 * Messages are wrapped in the signaling envelope:
 *   { type: "jsonrpc", data: <JsonRpcRequest> }
 *
 * The device is expected to respond with:
 *   { type: "jsonrpc", data: <JsonRpcResponse> }
 */
export function sendJsonRpc(
  ws: WebSocket,
  method: string,
  params: Record<string, unknown>,
  timeoutMs = 10000,
): Promise<any> {
  return new Promise((resolve, reject) => {
    const id = ++rpcIdCounter;

    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      method,
      params,
      id,
    };

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`JsonRPC timeout waiting for response to ${method}`));
    }, timeoutMs);

    function onMessage(data: Buffer | string) {
      try {
        const msg = JSON.parse(data.toString());
        // Handle both envelope-wrapped and direct JsonRPC responses
        const rpcResp: JsonRpcResponse =
          msg.type === "jsonrpc" ? msg.data : msg;

        if (rpcResp.id !== id) return; // Not our response

        cleanup();

        if (rpcResp.error) {
          reject(
            new Error(
              `JsonRPC error from device: ${rpcResp.error.message || JSON.stringify(rpcResp.error)}`,
            ),
          );
        } else {
          resolve(rpcResp.result);
        }
      } catch {
        // Ignore non-JSON or unrelated messages
      }
    }

    function cleanup() {
      clearTimeout(timer);
      ws.off("message", onMessage);
    }

    ws.on("message", onMessage);

    ws.send(
      JSON.stringify({
        type: "jsonrpc",
        data: request,
      }),
    );
  });
}
