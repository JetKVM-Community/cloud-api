import { InternalServerError } from "./errors";
import { validRange } from "semver";

/**
 * Computes SHA-256 hash of an ArrayBuffer and returns hex string.
 */
export async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Verifies that an R2 object's content matches the expected SHA-256 hash.
 */
export async function verifyHash(
  fileBody: ReadableStream | ArrayBuffer,
  hashText: string,
  exception?: string,
): Promise<boolean> {
  const content =
    fileBody instanceof ArrayBuffer
      ? fileBody
      : await new Response(fileBody).arrayBuffer();
  const localHash = await sha256Hex(content);
  const matches = hashText.trim() === localHash;
  if (!matches && exception) {
    throw new InternalServerError(exception);
  }
  return matches;
}

export function toSemverRange(range?: string) {
  if (!range) return "*";
  return validRange(range) || "*";
}

/**
 * Computes a deterministic rollout bucket (0-99) for a device ID.
 * Uses SHA-256 since Web Crypto does not support MD5.
 */
export async function getDeviceRolloutBucket(
  deviceId: string,
): Promise<number> {
  const data = new TextEncoder().encode(deviceId);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const view = new DataView(hashBuffer);
  const value = view.getUint32(0);
  return value % 100;
}

/**
 * Generate a random hex token of the given byte length.
 */
export function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
