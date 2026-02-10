import { describe, it, expect, beforeEach, vi } from "vitest";
import { Hono } from "hono";
import type { AppType } from "../src/env";
import { HttpError } from "../src/errors";
import {
  mockBucket,
  releaseStore,
  setRollout,
  resetToSeedData,
} from "./setup";
import { getDeviceRolloutBucket } from "../src/helpers";
import {
  Retrieve,
  RetrieveLatestApp,
  RetrieveLatestSystemRecovery,
  clearCaches,
} from "../src/releases";

// =========================================================================
// Test Hono app
// =========================================================================

function createTestApp() {
  const app = new Hono<AppType>();

  // Inject mock prisma per request
  app.use("*", async (c, next) => {
    c.set("prisma", releaseStore.createPrismaMock() as any);
    await next();
  });

  app.get("/releases", Retrieve);
  app.get("/releases/app/latest", RetrieveLatestApp);
  app.get(
    "/releases/system_recovery/latest",
    RetrieveLatestSystemRecovery,
  );

  app.onError((err, c) => {
    const statusCode = err instanceof HttpError ? err.status : 500;
    return c.json(
      { name: err.name, message: err.message },
      statusCode as any,
    );
  });

  return app;
}

const app = createTestApp();

const mockEnv = {
  R2_BUCKET: mockBucket,
  R2_CDN_URL: "https://cdn.test.com",
} as any;

// =========================================================================
// R2 mock helpers
// =========================================================================

/** Put a marker file so a version directory appears in `bucket.list` with delimiter. */
function mockR2ListVersions(
  prefix: "app" | "system",
  versions: string[],
) {
  for (const v of versions) {
    mockBucket.putText(`${prefix}/${v}/.v`, "1");
  }
}

/** Legacy version hash file (no SKU support). */
function mockR2HashFile(
  prefix: "app" | "system",
  version: string,
  hash: string,
) {
  const fileName = prefix === "app" ? "jetkvm_app" : "system.tar";
  mockBucket.putText(`${prefix}/${version}/${fileName}.sha256`, hash);
}

/** SKU-enabled version (artifact + hash under skus/ path). */
function mockR2SkuVersion(
  prefix: "app" | "system",
  version: string,
  sku: string,
  hash: string,
) {
  const fileName = prefix === "app" ? "jetkvm_app" : "system.tar";
  const skuPath = `${prefix}/${version}/skus/${sku}/${fileName}`;
  mockBucket.putText(skuPath, "artifact-content");
  mockBucket.putText(`${skuPath}.sha256`, hash);
}

/** Legacy version with full content (for redirect endpoints that do hash verification). */
function mockR2LegacyVersionWithContent(
  prefix: "app" | "system",
  version: string,
  fileName: string,
  content: string,
  hash: string,
) {
  mockBucket.putText(`${prefix}/${version}/${fileName}`, content);
  mockBucket.putText(`${prefix}/${version}/${fileName}.sha256`, hash);
}

/** SKU version with full content (for redirect endpoints that do hash verification). */
function mockR2SkuVersionWithContent(
  prefix: "app" | "system",
  version: string,
  sku: string,
  fileName: string,
  content: string,
  hash: string,
) {
  const skuPath = `${prefix}/${version}/skus/${sku}/${fileName}`;
  mockBucket.putText(skuPath, content);
  mockBucket.putText(`${skuPath}.sha256`, hash);
}

// =========================================================================
// Helpers
// =========================================================================

async function findDeviceIdOutsideRollout(threshold: number) {
  for (let i = 0; i < 10000; i += 1) {
    const candidate = `device-not-eligible-${i}`;
    if ((await getDeviceRolloutBucket(candidate)) >= threshold) {
      return candidate;
    }
  }
  throw new Error("Failed to find deviceId outside rollout bucket");
}

async function findDeviceIdInsideRollout(threshold: number) {
  for (let i = 0; i < 10000; i += 1) {
    const candidate = `device-eligible-${i}`;
    if ((await getDeviceRolloutBucket(candidate)) < threshold) {
      return candidate;
    }
  }
  throw new Error("Failed to find deviceId inside rollout bucket");
}

function buildUrl(
  path: string,
  query: Record<string, string | undefined>,
): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, value);
  }
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

/** Compute SHA-256 hex digest using Web Crypto API. */
async function sha256(content: string): Promise<string> {
  const data = new TextEncoder().encode(content);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(hashBuffer)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// =========================================================================
// Tests
// =========================================================================

describe("Retrieve handler", () => {
  beforeEach(() => {
    mockBucket.reset();
    clearCaches();
  });

  describe("input validation", () => {
    it("should return 400 when deviceId is missing", async () => {
      const res = await app.request("/releases", {}, mockEnv);
      expect(res.status).toBe(400);
      const body = (await res.json()) as any;
      expect(body.message).toContain("Device ID is required");
    });

    it("should return 400 when deviceId is empty string", async () => {
      const res = await app.request("/releases?deviceId=", {}, mockEnv);
      expect(res.status).toBe(400);
    });
  });

  describe("R2 error handling", () => {
    it("should return 404 when no versions exist in R2", async () => {
      const res = await app.request(
        "/releases?deviceId=device-123",
        {},
        mockEnv,
      );
      expect(res.status).toBe(404);
    });

    it("should return 404 when no valid semver versions exist", async () => {
      mockR2ListVersions("app", ["invalid-version", "not-semver"]);
      mockR2ListVersions("system", ["invalid-version", "not-semver"]);

      const res = await app.request(
        "/releases?deviceId=device-123",
        {},
        mockEnv,
      );
      expect(res.status).toBe(404);
    });
  });

  describe("prerelease mode", () => {
    it("should return latest prerelease version when prerelease=true", async () => {
      mockR2ListVersions("app", ["1.0.0", "1.1.0", "2.0.0-beta.1"]);
      mockR2ListVersions("system", ["1.0.0", "1.1.0", "2.0.0-alpha.1"]);
      mockR2HashFile("app", "2.0.0-beta.1", "prerelease-app-hash");
      mockR2HashFile("system", "2.0.0-alpha.1", "prerelease-system-hash");

      const url = buildUrl("/releases", {
        deviceId: "device-123",
        prerelease: "true",
      });
      const res = await app.request(url, {}, mockEnv);
      expect(res.status).toBe(200);

      const body = (await res.json()) as any;
      expect(body.appVersion).toBe("2.0.0-beta.1");
      expect(body.systemVersion).toBe("2.0.0-alpha.1");
    });

    it("should skip rollout logic for prereleases", async () => {
      mockR2ListVersions("app", ["3.0.0", "3.1.0-rc.1"]);
      mockR2ListVersions("system", ["3.0.0", "3.1.0-rc.1"]);
      mockR2HashFile("app", "3.1.0-rc.1", "rc-app-hash");
      mockR2HashFile("system", "3.1.0-rc.1", "rc-system-hash");

      const url = buildUrl("/releases", {
        deviceId: "device-456",
        prerelease: "true",
        appVersion: "^3.0.0",
        systemVersion: "^3.0.0",
      });
      const res = await app.request(url, {}, mockEnv);
      expect(res.status).toBe(200);

      const body = (await res.json()) as any;
      expect(body.appVersion).toBe("3.1.0-rc.1");
      expect(body.systemVersion).toBe("3.1.0-rc.1");
    });
  });

  describe("version constraints", () => {
    it("should respect appVersion constraint", async () => {
      mockR2ListVersions("app", ["1.0.0", "1.1.0", "2.0.0"]);
      mockR2ListVersions("system", ["1.0.0", "2.0.0"]);
      mockR2HashFile("app", "1.1.0", "app-hash-110");
      mockR2HashFile("system", "2.0.0", "system-hash-200");

      const url = buildUrl("/releases", {
        deviceId: "device-123",
        appVersion: "^1.0.0",
      });
      const res = await app.request(url, {}, mockEnv);
      expect(res.status).toBe(200);

      const body = (await res.json()) as any;
      expect(body.appVersion).toBe("1.1.0"); // Max satisfying ^1.0.0
      expect(body.systemVersion).toBe("2.0.0"); // No constraint, get latest
    });

    it("should respect systemVersion constraint", async () => {
      mockR2ListVersions("app", ["1.0.0", "2.0.0"]);
      mockR2ListVersions("system", ["1.0.0", "1.0.5", "1.1.0", "2.0.0"]);
      mockR2HashFile("app", "2.0.0", "app-hash-200");
      mockR2HashFile("system", "1.0.5", "system-hash-105");

      const url = buildUrl("/releases", {
        deviceId: "device-123",
        systemVersion: "~1.0.0",
      });
      const res = await app.request(url, {}, mockEnv);
      expect(res.status).toBe(200);

      const body = (await res.json()) as any;
      expect(body.appVersion).toBe("2.0.0");
      expect(body.systemVersion).toBe("1.0.5"); // Max satisfying ~1.0.0
    });

    it("should skip rollout when version constraints are specified", async () => {
      mockR2ListVersions("app", ["1.0.0", "2.0.0"]);
      mockR2ListVersions("system", ["1.0.0", "2.0.0"]);
      mockR2HashFile("app", "1.0.0", "app-hash-100");
      mockR2HashFile("system", "1.0.0", "system-hash-100");
      await setRollout("1.0.0", "app", 0);
      await setRollout("1.0.0", "system", 0);

      const url = buildUrl("/releases", {
        deviceId: "device-123",
        appVersion: "1.0.0",
        systemVersion: "1.0.0",
      });
      const res = await app.request(url, {}, mockEnv);
      expect(res.status).toBe(200);

      const body = (await res.json()) as any;
      // Should return specified version directly (skipRollout=true)
      expect(body.appVersion).toBe("1.0.0");
      expect(body.systemVersion).toBe("1.0.0");
    });

    it("should return 404 when no version satisfies constraint", async () => {
      mockR2ListVersions("app", ["1.0.0", "2.0.0"]);

      const url = buildUrl("/releases", {
        deviceId: "device-123",
        appVersion: "^5.0.0",
      });
      const res = await app.request(url, {}, mockEnv);
      expect(res.status).toBe(404);
    });
  });

  describe("SKU handling", () => {
    it("should use legacy path when no SKU provided on legacy version", async () => {
      mockR2ListVersions("app", ["1.0.0"]);
      mockR2ListVersions("system", ["1.0.0"]);
      mockR2HashFile("app", "1.0.0", "legacy-app-hash");
      mockR2HashFile("system", "1.0.0", "legacy-system-hash");

      const url = buildUrl("/releases", {
        deviceId: "device-123",
        appVersion: "1.0.0",
        systemVersion: "1.0.0",
      });
      const res = await app.request(url, {}, mockEnv);
      expect(res.status).toBe(200);

      const body = (await res.json()) as any;
      expect(body.appVersion).toBe("1.0.0");
      expect(body.appUrl).toBe(
        "https://cdn.test.com/app/1.0.0/jetkvm_app",
      );
      expect(body.systemUrl).toBe(
        "https://cdn.test.com/system/1.0.0/system.tar",
      );
    });

    it("should use legacy path when default SKU provided on legacy version", async () => {
      mockR2ListVersions("app", ["1.0.0"]);
      mockR2ListVersions("system", ["1.0.0"]);
      mockR2HashFile("app", "1.0.0", "legacy-app-hash-2");
      mockR2HashFile("system", "1.0.0", "legacy-system-hash-2");

      const url = buildUrl("/releases", {
        deviceId: "device-123",
        sku: "jetkvm-v2",
        appVersion: "1.0.0",
        systemVersion: "1.0.0",
      });
      const res = await app.request(url, {}, mockEnv);
      expect(res.status).toBe(200);

      const body = (await res.json()) as any;
      expect(body.appUrl).toBe(
        "https://cdn.test.com/app/1.0.0/jetkvm_app",
      );
      expect(body.systemUrl).toBe(
        "https://cdn.test.com/system/1.0.0/system.tar",
      );
    });

    it("should return 404 when non-default SKU requested on legacy version", async () => {
      mockR2ListVersions("app", ["1.0.0"]);
      mockR2ListVersions("system", ["1.0.0"]);
      mockR2HashFile("app", "1.0.0", "legacy-app-hash-3");
      mockR2HashFile("system", "1.0.0", "legacy-system-hash-3");

      const url = buildUrl("/releases", {
        deviceId: "device-123",
        sku: "jetkvm-2",
        appVersion: "1.0.0",
        systemVersion: "1.0.0",
      });
      const res = await app.request(url, {}, mockEnv);
      expect(res.status).toBe(404);

      const body = (await res.json()) as any;
      expect(body.message).toContain("predates SKU support");
    });

    it("should use SKU path when version has SKU support", async () => {
      mockR2ListVersions("app", ["2.0.0"]);
      mockR2ListVersions("system", ["2.0.0"]);
      mockR2SkuVersion("app", "2.0.0", "jetkvm-2", "sku-app-hash");
      mockR2SkuVersion("system", "2.0.0", "jetkvm-2", "sku-system-hash");

      const url = buildUrl("/releases", {
        deviceId: "device-123",
        sku: "jetkvm-2",
        appVersion: "^2.0.0",
        systemVersion: "^2.0.0",
      });
      const res = await app.request(url, {}, mockEnv);
      expect(res.status).toBe(200);

      const body = (await res.json()) as any;
      expect(body.appVersion).toBe("2.0.0");
      expect(body.appUrl).toBe(
        "https://cdn.test.com/app/2.0.0/skus/jetkvm-2/jetkvm_app",
      );
      expect(body.systemUrl).toBe(
        "https://cdn.test.com/system/2.0.0/skus/jetkvm-2/system.tar",
      );
    });

    it("should use default SKU when no SKU provided on version with SKU support", async () => {
      mockR2ListVersions("app", ["2.0.0"]);
      mockR2ListVersions("system", ["2.0.0"]);
      mockR2SkuVersion(
        "app",
        "2.0.0",
        "jetkvm-v2",
        "default-sku-app-hash",
      );
      mockR2SkuVersion(
        "system",
        "2.0.0",
        "jetkvm-v2",
        "default-sku-system-hash",
      );

      const url = buildUrl("/releases", {
        deviceId: "device-123",
        appVersion: "^2.0.0",
        systemVersion: "^2.0.0",
      });
      const res = await app.request(url, {}, mockEnv);
      expect(res.status).toBe(200);

      const body = (await res.json()) as any;
      expect(body.appUrl).toBe(
        "https://cdn.test.com/app/2.0.0/skus/jetkvm-v2/jetkvm_app",
      );
      expect(body.systemUrl).toBe(
        "https://cdn.test.com/system/2.0.0/skus/jetkvm-v2/system.tar",
      );
    });

    it("should return 404 when requested SKU not available on version with SKU support", async () => {
      mockR2ListVersions("app", ["2.0.0"]);
      mockR2ListVersions("system", ["2.0.0"]);
      // jetkvm-v2 exists but jetkvm-3 doesn't
      mockBucket.putText(
        "app/2.0.0/skus/jetkvm-v2/jetkvm_app",
        "content",
      );
      mockBucket.putText(
        "system/2.0.0/skus/jetkvm-v2/system.tar",
        "content",
      );

      const url = buildUrl("/releases", {
        deviceId: "device-123",
        sku: "jetkvm-3",
        appVersion: "^2.0.0",
        systemVersion: "^2.0.0",
      });
      const res = await app.request(url, {}, mockEnv);
      expect(res.status).toBe(404);

      const body = (await res.json()) as any;
      expect(body.message).toContain("is not available for version");
    });
  });

  describe("forceUpdate mode", () => {
    it("should return latest release when forceUpdate=true", async () => {
      mockR2ListVersions("app", ["1.0.0", "1.5.5"]);
      mockR2ListVersions("system", ["1.0.0", "1.5.5"]);
      mockR2HashFile("app", "1.5.5", "force-app-hash");
      mockR2HashFile("system", "1.5.5", "force-system-hash");

      const url = buildUrl("/releases", {
        deviceId: "device-force",
        forceUpdate: "true",
        appVersion: "^1.5.0",
        systemVersion: "^1.5.0",
      });
      const res = await app.request(url, {}, mockEnv);
      expect(res.status).toBe(200);

      const body = (await res.json()) as any;
      expect(body.appVersion).toBe("1.5.5");
      expect(body.systemVersion).toBe("1.5.5");
    });
  });

  describe("rollout logic", () => {
    beforeEach(async () => {
      await resetToSeedData();
    });

    it("should return default release for device not in rollout percentage", async () => {
      await setRollout("1.1.0", "app", 100);
      await setRollout("1.1.0", "system", 100);
      await setRollout("1.2.0", "app", 10);
      await setRollout("1.2.0", "system", 10);

      const deviceId = await findDeviceIdOutsideRollout(10);

      mockR2ListVersions("app", ["1.0.0", "1.1.0", "1.2.0"]);
      mockR2ListVersions("system", ["1.0.0", "1.1.0", "1.2.0"]);
      mockR2HashFile("app", "1.2.0", "abc123hash120");
      mockR2HashFile("system", "1.2.0", "sys123hash120");

      const res = await app.request(
        `/releases?deviceId=${deviceId}`,
        {},
        mockEnv,
      );
      expect(res.status).toBe(200);

      const body = (await res.json()) as any;
      // Device not in 10% rollout should get 1.1.0 (latest 100% default)
      expect(body.appVersion).toBe("1.1.0");
      expect(body.systemVersion).toBe("1.1.0");
    });

    it("should return latest release when device is in rollout percentage", async () => {
      await setRollout("1.1.0", "app", 100);
      await setRollout("1.1.0", "system", 100);
      await setRollout("1.2.0", "app", 10);
      await setRollout("1.2.0", "system", 10);

      const deviceId = await findDeviceIdInsideRollout(10);

      mockR2ListVersions("app", ["1.0.0", "1.1.0", "1.2.0"]);
      mockR2ListVersions("system", ["1.0.0", "1.1.0", "1.2.0"]);
      mockR2HashFile("app", "1.2.0", "abc123hash120");
      mockR2HashFile("system", "1.2.0", "sys123hash120");

      const res = await app.request(
        `/releases?deviceId=${deviceId}`,
        {},
        mockEnv,
      );
      expect(res.status).toBe(200);

      const body = (await res.json()) as any;
      expect(body.appVersion).toBe("1.2.0");
      expect(body.systemVersion).toBe("1.2.0");
    });

    it("should return default when rollout is 0%", async () => {
      await setRollout("1.1.0", "app", 100);
      await setRollout("1.1.0", "system", 100);
      await setRollout("1.2.0", "app", 0);
      await setRollout("1.2.0", "system", 0);

      mockR2ListVersions("app", ["1.0.0", "1.1.0", "1.2.0"]);
      mockR2ListVersions("system", ["1.0.0", "1.1.0", "1.2.0"]);
      mockR2HashFile("app", "1.2.0", "abc123hash120");
      mockR2HashFile("system", "1.2.0", "sys123hash120");

      const res = await app.request(
        "/releases?deviceId=any-device",
        {},
        mockEnv,
      );
      expect(res.status).toBe(200);

      const body = (await res.json()) as any;
      // With 0% rollout, all devices get the default (1.1.0)
      expect(body.appVersion).toBe("1.1.0");
      expect(body.systemVersion).toBe("1.1.0");
    });

    it("should evaluate app and system rollout independently", async () => {
      await setRollout("1.1.0", "app", 100);
      await setRollout("1.1.0", "system", 100);
      await setRollout("1.2.0", "app", 100); // All devices get latest app
      await setRollout("1.2.0", "system", 0); // No devices get latest system

      mockR2ListVersions("app", ["1.0.0", "1.1.0", "1.2.0"]);
      mockR2ListVersions("system", ["1.0.0", "1.1.0", "1.2.0"]);
      mockR2HashFile("app", "1.2.0", "abc123hash120");
      mockR2HashFile("system", "1.2.0", "sys123hash120");

      const res = await app.request(
        "/releases?deviceId=any-device",
        {},
        mockEnv,
      );
      expect(res.status).toBe(200);

      const body = (await res.json()) as any;
      // App gets 1.2.0 (100% rollout), system stays at 1.1.0 (0% rollout)
      expect(body.appVersion).toBe("1.2.0");
      expect(body.systemVersion).toBe("1.1.0");
    });
  });

  describe("default release handling", () => {
    beforeEach(async () => {
      await resetToSeedData();
    });

    it("should return 500 when no default release exists", async () => {
      // Set all releases to non-100% rollout (no default available)
      await setRollout("1.0.0", "app", 50);
      await setRollout("1.1.0", "app", 50);
      await setRollout("1.2.0", "app", 50);
      await setRollout("1.0.0", "system", 50);
      await setRollout("1.1.0", "system", 50);
      await setRollout("1.2.0", "system", 50);

      mockR2ListVersions("app", ["1.0.0", "1.2.0"]);
      mockR2ListVersions("system", ["1.0.0", "1.2.0"]);
      mockR2HashFile("app", "1.2.0", "abc123hash120");
      mockR2HashFile("system", "1.2.0", "sys123hash120");

      const res = await app.request(
        "/releases?deviceId=device-123",
        {},
        mockEnv,
      );
      expect(res.status).toBe(500);
    });
  });

  describe("R2 error handling (non-NotFoundError)", () => {
    it("should return 500 when R2 throws unexpected error", async () => {
      const listSpy = vi
        .spyOn(mockBucket, "list")
        .mockRejectedValueOnce(new Error("Network timeout"));

      const res = await app.request(
        "/releases?deviceId=device-123",
        {},
        mockEnv,
      );
      expect(res.status).toBe(500);

      const body = (await res.json()) as any;
      expect(body.message).toContain(
        "Failed to get the latest release",
      );

      listSpy.mockRestore();
    });
  });

  describe("cache behavior", () => {
    it("should return cached release on second call with same parameters", async () => {
      mockR2ListVersions("app", ["5.0.0", "5.1.0"]);
      mockR2ListVersions("system", ["5.0.0", "5.1.0"]);
      mockR2HashFile("app", "5.1.0", "cache-app-hash");
      mockR2HashFile("system", "5.1.0", "cache-system-hash");

      const url = buildUrl("/releases", {
        deviceId: "cache-test-device",
        prerelease: "true",
        appVersion: "^5.0.0",
        systemVersion: "^5.0.0",
      });
      const res1 = await app.request(url, {}, mockEnv);
      expect(res1.status).toBe(200);
      const body1 = (await res1.json()) as any;
      expect(body1.appVersion).toBe("5.1.0");

      // Reset bucket with different data
      mockBucket.reset();
      mockR2ListVersions("app", ["5.0.0", "5.2.0"]);
      mockR2ListVersions("system", ["5.0.0", "5.2.0"]);
      mockR2HashFile("app", "5.2.0", "new-app-hash");
      mockR2HashFile("system", "5.2.0", "new-system-hash");

      // Second call should return cached result (5.1.0), not new R2 data (5.2.0)
      const url2 = buildUrl("/releases", {
        deviceId: "cache-test-device-2",
        prerelease: "true",
        appVersion: "^5.0.0",
        systemVersion: "^5.0.0",
      });
      const res2 = await app.request(url2, {}, mockEnv);
      expect(res2.status).toBe(200);
      const body2 = (await res2.json()) as any;
      expect(body2.appVersion).toBe("5.1.0"); // Still cached
    });
  });

  describe("new release auto-creation", () => {
    beforeEach(async () => {
      await resetToSeedData();
    });

    it("should create new release with 10% rollout when version not in DB", async () => {
      const newVersion = "9.9.9";

      mockR2ListVersions("app", ["1.0.0", newVersion]);
      mockR2ListVersions("system", ["1.0.0", newVersion]);
      mockR2HashFile("app", newVersion, "new-version-app-hash");
      mockR2HashFile("system", newVersion, "new-version-system-hash");

      const res = await app.request(
        "/releases?deviceId=new-release-device",
        {},
        mockEnv,
      );
      expect(res.status).toBe(200);

      // Verify the new release was created in the store with 10% rollout
      const createdAppRelease = releaseStore.releases.find(
        (r) => r.version === newVersion && r.type === "app",
      );
      const createdSystemRelease = releaseStore.releases.find(
        (r) => r.version === newVersion && r.type === "system",
      );

      expect(createdAppRelease).toBeDefined();
      expect(createdAppRelease?.rolloutPercentage).toBe(10);
      expect(createdSystemRelease).toBeDefined();
      expect(createdSystemRelease?.rolloutPercentage).toBe(10);
    });
  });

  describe("default release selection", () => {
    beforeEach(async () => {
      await resetToSeedData();
    });

    it("should return latest version among multiple 100% rollout releases", async () => {
      await setRollout("1.0.0", "app", 100);
      await setRollout("1.1.0", "app", 100);
      await setRollout("1.2.0", "app", 0);
      await setRollout("1.0.0", "system", 100);
      await setRollout("1.1.0", "system", 100);
      await setRollout("1.2.0", "system", 0);

      mockR2ListVersions("app", ["1.0.0", "1.1.0", "1.2.0"]);
      mockR2ListVersions("system", ["1.0.0", "1.1.0", "1.2.0"]);
      mockR2HashFile("app", "1.2.0", "abc123hash120");
      mockR2HashFile("system", "1.2.0", "sys123hash120");

      const res = await app.request(
        "/releases?deviceId=default-selection-device",
        {},
        mockEnv,
      );
      expect(res.status).toBe(200);

      const body = (await res.json()) as any;
      // 1.2.0 has 0% rollout, so device gets 1.1.0 (latest 100% default)
      expect(body.appVersion).toBe("1.1.0");
      expect(body.systemVersion).toBe("1.1.0");
    });
  });

  describe("rollout eligibility", () => {
    beforeEach(async () => {
      await resetToSeedData();
    });

    it("should be deterministic - same deviceId always gets same result", async () => {
      await setRollout("1.1.0", "app", 100);
      await setRollout("1.1.0", "system", 100);
      await setRollout("1.2.0", "app", 50);
      await setRollout("1.2.0", "system", 50);

      const deviceId = "deterministic-test-device-abc123";

      mockR2ListVersions("app", ["1.0.0", "1.1.0", "1.2.0"]);
      mockR2ListVersions("system", ["1.0.0", "1.1.0", "1.2.0"]);
      mockR2HashFile("app", "1.2.0", "abc123hash120");
      mockR2HashFile("system", "1.2.0", "sys123hash120");

      const res1 = await app.request(
        `/releases?deviceId=${deviceId}`,
        {},
        mockEnv,
      );
      expect(res1.status).toBe(200);
      const body1 = (await res1.json()) as any;

      // Clear caches and re-set up R2 data
      clearCaches();
      mockBucket.reset();

      mockR2ListVersions("app", ["1.0.0", "1.1.0", "1.2.0"]);
      mockR2ListVersions("system", ["1.0.0", "1.1.0", "1.2.0"]);
      mockR2HashFile("app", "1.2.0", "abc123hash120");
      mockR2HashFile("system", "1.2.0", "sys123hash120");

      const res2 = await app.request(
        `/releases?deviceId=${deviceId}`,
        {},
        mockEnv,
      );
      expect(res2.status).toBe(200);
      const body2 = (await res2.json()) as any;

      // Same deviceId should get same versions (deterministic)
      expect(body2.appVersion).toBe(body1.appVersion);
      expect(body2.systemVersion).toBe(body1.systemVersion);
    });
  });

  describe("response structure", () => {
    it("should include all required fields in response", async () => {
      mockR2ListVersions("app", ["1.0.0"]);
      mockR2ListVersions("system", ["1.0.0"]);
      mockR2HashFile("app", "1.0.0", "app-hash");
      mockR2HashFile("system", "1.0.0", "system-hash");

      const url = buildUrl("/releases", {
        deviceId: "device-123",
        prerelease: "true",
      });
      const res = await app.request(url, {}, mockEnv);
      expect(res.status).toBe(200);

      const body = (await res.json()) as any;
      expect(body).toHaveProperty("appVersion");
      expect(body).toHaveProperty("appUrl");
      expect(body).toHaveProperty("appHash");
      expect(body).toHaveProperty("systemVersion");
      expect(body).toHaveProperty("systemUrl");
      expect(body).toHaveProperty("systemHash");
    });

    it("should return correct URL format", async () => {
      mockR2ListVersions("app", ["4.0.0"]);
      mockR2ListVersions("system", ["4.0.0"]);
      mockR2HashFile("app", "4.0.0", "app-hash-400");
      mockR2HashFile("system", "4.0.0", "system-hash-400");

      const url = buildUrl("/releases", {
        deviceId: "device-url-test",
        prerelease: "true",
        appVersion: "^4.0.0",
        systemVersion: "^4.0.0",
      });
      const res = await app.request(url, {}, mockEnv);
      expect(res.status).toBe(200);

      const body = (await res.json()) as any;
      expect(body.appUrl).toBe(
        "https://cdn.test.com/app/4.0.0/jetkvm_app",
      );
      expect(body.systemUrl).toBe(
        "https://cdn.test.com/system/4.0.0/system.tar",
      );
    });
  });
});

// =========================================================================
// RetrieveLatestApp
// =========================================================================

describe("RetrieveLatestApp handler", () => {
  beforeEach(() => {
    mockBucket.reset();
    clearCaches();
  });

  it("should return 404 when all versions are invalid semver", async () => {
    mockR2ListVersions("app", ["not-valid", "bad-version"]);

    const res = await app.request("/releases/app/latest", {}, mockEnv);
    expect(res.status).toBe(404);
  });

  it("should return 404 when no app versions exist", async () => {
    const res = await app.request("/releases/app/latest", {}, mockEnv);
    expect(res.status).toBe(404);
  });

  it("should redirect to latest stable app version", async () => {
    const content = "app-binary-content";
    const hash = await sha256(content);

    mockR2ListVersions("app", ["1.0.0", "1.1.0", "1.2.0"]);
    mockR2LegacyVersionWithContent(
      "app",
      "1.2.0",
      "jetkvm_app",
      content,
      await hash,
    );

    const res = await app.request("/releases/app/latest", {}, mockEnv);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(
      "https://cdn.test.com/app/1.2.0/jetkvm_app",
    );
  });

  it("should redirect to latest prerelease when prerelease=true", async () => {
    const content = "app-prerelease-content";
    const hash = await sha256(content);

    mockR2ListVersions("app", ["1.0.0", "1.1.0", "2.0.0-beta.1"]);
    mockR2LegacyVersionWithContent(
      "app",
      "2.0.0-beta.1",
      "jetkvm_app",
      content,
      await hash,
    );

    const res = await app.request(
      "/releases/app/latest?prerelease=true",
      {},
      mockEnv,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(
      "https://cdn.test.com/app/2.0.0-beta.1/jetkvm_app",
    );
  });

  it("should return 500 when hash does not match", async () => {
    mockR2ListVersions("app", ["1.0.0"]);
    mockR2LegacyVersionWithContent(
      "app",
      "1.0.0",
      "jetkvm_app",
      "actual-content",
      "wrong-hash-value",
    );

    const res = await app.request("/releases/app/latest", {}, mockEnv);
    expect(res.status).toBe(500);
  });

  it("should return 404 when app file is missing", async () => {
    // Put hash file but not the app file itself
    mockR2ListVersions("app", ["1.0.0"]);
    mockBucket.putText("app/1.0.0/jetkvm_app.sha256", "some-hash");

    const res = await app.request("/releases/app/latest", {}, mockEnv);
    expect(res.status).toBe(404);
  });

  describe("SKU handling", () => {
    it("should use legacy path when no SKU provided on legacy version", async () => {
      const content = "legacy-app-content";
      const hash = await sha256(content);

      mockR2ListVersions("app", ["1.0.0"]);
      mockR2LegacyVersionWithContent(
        "app",
        "1.0.0",
        "jetkvm_app",
        content,
        await hash,
      );

      const res = await app.request("/releases/app/latest", {}, mockEnv);
      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe(
        "https://cdn.test.com/app/1.0.0/jetkvm_app",
      );
    });

    it("should use legacy path when default SKU provided on legacy version", async () => {
      const content = "legacy-app-content-default-sku";
      const hash = await sha256(content);

      mockR2ListVersions("app", ["1.0.0"]);
      mockR2LegacyVersionWithContent(
        "app",
        "1.0.0",
        "jetkvm_app",
        content,
        await hash,
      );

      const res = await app.request(
        "/releases/app/latest?sku=jetkvm-v2",
        {},
        mockEnv,
      );
      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe(
        "https://cdn.test.com/app/1.0.0/jetkvm_app",
      );
    });

    it("should return 404 when non-default SKU requested on legacy version", async () => {
      mockR2ListVersions("app", ["1.0.0"]);

      const res = await app.request(
        "/releases/app/latest?sku=jetkvm-2",
        {},
        mockEnv,
      );
      expect(res.status).toBe(404);

      const body = (await res.json()) as any;
      expect(body.message).toContain("predates SKU support");
    });

    it("should use SKU path when version has SKU support", async () => {
      const content = "sku-app-content";
      const hash = await sha256(content);

      mockR2ListVersions("app", ["2.0.0"]);
      mockR2SkuVersionWithContent(
        "app",
        "2.0.0",
        "jetkvm-2",
        "jetkvm_app",
        content,
        await hash,
      );

      const res = await app.request(
        "/releases/app/latest?sku=jetkvm-2",
        {},
        mockEnv,
      );
      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe(
        "https://cdn.test.com/app/2.0.0/skus/jetkvm-2/jetkvm_app",
      );
    });

    it("should use default SKU when no SKU provided on version with SKU support", async () => {
      const content = "default-sku-app-content";
      const hash = await sha256(content);

      mockR2ListVersions("app", ["2.0.0"]);
      mockR2SkuVersionWithContent(
        "app",
        "2.0.0",
        "jetkvm-v2",
        "jetkvm_app",
        content,
        await hash,
      );

      const res = await app.request("/releases/app/latest", {}, mockEnv);
      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe(
        "https://cdn.test.com/app/2.0.0/skus/jetkvm-v2/jetkvm_app",
      );
    });

    it("should return 404 when requested SKU not available on version with SKU support", async () => {
      mockR2ListVersions("app", ["2.0.0"]);
      // jetkvm-v2 exists but jetkvm-3 doesn't
      mockBucket.putText(
        "app/2.0.0/skus/jetkvm-v2/jetkvm_app",
        "content",
      );

      const res = await app.request(
        "/releases/app/latest?sku=jetkvm-3",
        {},
        mockEnv,
      );
      expect(res.status).toBe(404);

      const body = (await res.json()) as any;
      expect(body.message).toContain("is not available for version");
    });
  });

  describe("cache behavior", () => {
    it("should return cached redirect on second call with same parameters", async () => {
      const content = "cached-app-content";
      const hash = await sha256(content);

      mockR2ListVersions("app", ["1.0.0"]);
      mockR2LegacyVersionWithContent(
        "app",
        "1.0.0",
        "jetkvm_app",
        content,
        await hash,
      );

      const res1 = await app.request(
        "/releases/app/latest",
        {},
        mockEnv,
      );
      expect(res1.status).toBe(302);
      expect(res1.headers.get("Location")).toBe(
        "https://cdn.test.com/app/1.0.0/jetkvm_app",
      );

      // Reset bucket with different data
      mockBucket.reset();
      mockR2ListVersions("app", ["2.0.0"]);
      mockR2LegacyVersionWithContent(
        "app",
        "2.0.0",
        "jetkvm_app",
        "new-content",
        await sha256("new-content"),
      );

      // Second call should return cached result
      const res2 = await app.request(
        "/releases/app/latest",
        {},
        mockEnv,
      );
      expect(res2.status).toBe(302);
      expect(res2.headers.get("Location")).toBe(
        "https://cdn.test.com/app/1.0.0/jetkvm_app",
      );
    });

    it("should use different cache keys for different SKUs", async () => {
      const content = "sku-cache-test";
      const hash = await sha256(content);

      // First call with default SKU
      mockR2ListVersions("app", ["1.0.0"]);
      mockR2LegacyVersionWithContent(
        "app",
        "1.0.0",
        "jetkvm_app",
        content,
        await hash,
      );

      const res1 = await app.request(
        "/releases/app/latest",
        {},
        mockEnv,
      );
      expect(res1.status).toBe(302);
      expect(res1.headers.get("Location")).toBe(
        "https://cdn.test.com/app/1.0.0/jetkvm_app",
      );

      // Second call with different SKU should NOT use cached result
      mockBucket.reset();
      mockR2ListVersions("app", ["2.0.0"]);
      mockR2SkuVersionWithContent(
        "app",
        "2.0.0",
        "jetkvm-2",
        "jetkvm_app",
        content,
        await hash,
      );

      const res2 = await app.request(
        "/releases/app/latest?sku=jetkvm-2",
        {},
        mockEnv,
      );
      expect(res2.status).toBe(302);
      expect(res2.headers.get("Location")).toBe(
        "https://cdn.test.com/app/2.0.0/skus/jetkvm-2/jetkvm_app",
      );
    });
  });
});

// =========================================================================
// RetrieveLatestSystemRecovery
// =========================================================================

describe("RetrieveLatestSystemRecovery handler", () => {
  beforeEach(() => {
    mockBucket.reset();
    clearCaches();
  });

  it("should return 404 when all versions are invalid semver", async () => {
    mockR2ListVersions("system", [
      "not-a-version",
      "invalid",
      "v1.bad.format",
    ]);

    const res = await app.request(
      "/releases/system_recovery/latest",
      {},
      mockEnv,
    );
    expect(res.status).toBe(404);
  });

  it("should return 404 when no system versions exist", async () => {
    const res = await app.request(
      "/releases/system_recovery/latest",
      {},
      mockEnv,
    );
    expect(res.status).toBe(404);
  });

  it("should redirect to latest stable system recovery image", async () => {
    const content = "system-recovery-image-content";
    const hash = await sha256(content);

    mockR2ListVersions("system", ["1.0.0", "1.1.0", "1.2.0"]);
    mockR2LegacyVersionWithContent(
      "system",
      "1.2.0",
      "update.img",
      content,
      await hash,
    );

    const res = await app.request(
      "/releases/system_recovery/latest",
      {},
      mockEnv,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(
      "https://cdn.test.com/system/1.2.0/update.img",
    );
  });

  it("should redirect to latest prerelease when prerelease=true", async () => {
    const content = "system-prerelease-content";
    const hash = await sha256(content);

    mockR2ListVersions("system", ["1.0.0", "2.0.0-alpha.1"]);
    mockR2LegacyVersionWithContent(
      "system",
      "2.0.0-alpha.1",
      "update.img",
      content,
      await hash,
    );

    const res = await app.request(
      "/releases/system_recovery/latest?prerelease=true",
      {},
      mockEnv,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(
      "https://cdn.test.com/system/2.0.0-alpha.1/update.img",
    );
  });

  it("should return 500 when hash does not match", async () => {
    mockR2ListVersions("system", ["1.0.0"]);
    mockR2LegacyVersionWithContent(
      "system",
      "1.0.0",
      "update.img",
      "actual-content",
      "mismatched-hash",
    );

    const res = await app.request(
      "/releases/system_recovery/latest",
      {},
      mockEnv,
    );
    expect(res.status).toBe(500);
  });

  it("should return 404 when recovery image or hash file is missing", async () => {
    // Put only a marker (no update.img or hash file)
    mockR2ListVersions("system", ["1.0.0"]);

    const res = await app.request(
      "/releases/system_recovery/latest",
      {},
      mockEnv,
    );
    expect(res.status).toBe(404);
  });

  describe("SKU handling", () => {
    it("should use legacy path when no SKU provided on legacy version", async () => {
      const content = "legacy-recovery-content";
      const hash = await sha256(content);

      mockR2ListVersions("system", ["1.0.0"]);
      mockR2LegacyVersionWithContent(
        "system",
        "1.0.0",
        "update.img",
        content,
        await hash,
      );

      const res = await app.request(
        "/releases/system_recovery/latest",
        {},
        mockEnv,
      );
      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe(
        "https://cdn.test.com/system/1.0.0/update.img",
      );
    });

    it("should use legacy path when default SKU provided on legacy version", async () => {
      const content = "legacy-recovery-content-default-sku";
      const hash = await sha256(content);

      mockR2ListVersions("system", ["1.0.0"]);
      mockR2LegacyVersionWithContent(
        "system",
        "1.0.0",
        "update.img",
        content,
        await hash,
      );

      const res = await app.request(
        "/releases/system_recovery/latest?sku=jetkvm-v2",
        {},
        mockEnv,
      );
      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe(
        "https://cdn.test.com/system/1.0.0/update.img",
      );
    });

    it("should return 404 when non-default SKU requested on legacy version", async () => {
      mockR2ListVersions("system", ["1.0.0"]);

      const res = await app.request(
        "/releases/system_recovery/latest?sku=jetkvm-2",
        {},
        mockEnv,
      );
      expect(res.status).toBe(404);

      const body = (await res.json()) as any;
      expect(body.message).toContain("predates SKU support");
    });

    it("should use SKU path when version has SKU support", async () => {
      const content = "sku-recovery-content";
      const hash = await sha256(content);

      mockR2ListVersions("system", ["2.0.0"]);
      mockR2SkuVersionWithContent(
        "system",
        "2.0.0",
        "jetkvm-2",
        "update.img",
        content,
        await hash,
      );

      const res = await app.request(
        "/releases/system_recovery/latest?sku=jetkvm-2",
        {},
        mockEnv,
      );
      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe(
        "https://cdn.test.com/system/2.0.0/skus/jetkvm-2/update.img",
      );
    });

    it("should use default SKU when no SKU provided on version with SKU support", async () => {
      const content = "default-sku-recovery-content";
      const hash = await sha256(content);

      mockR2ListVersions("system", ["2.0.0"]);
      mockR2SkuVersionWithContent(
        "system",
        "2.0.0",
        "jetkvm-v2",
        "update.img",
        content,
        await hash,
      );

      const res = await app.request(
        "/releases/system_recovery/latest",
        {},
        mockEnv,
      );
      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe(
        "https://cdn.test.com/system/2.0.0/skus/jetkvm-v2/update.img",
      );
    });

    it("should return 404 when requested SKU not available on version with SKU support", async () => {
      mockR2ListVersions("system", ["2.0.0"]);
      mockBucket.putText(
        "system/2.0.0/skus/jetkvm-v2/update.img",
        "content",
      );

      const res = await app.request(
        "/releases/system_recovery/latest?sku=jetkvm-3",
        {},
        mockEnv,
      );
      expect(res.status).toBe(404);

      const body = (await res.json()) as any;
      expect(body.message).toContain("is not available for version");
    });
  });

  describe("cache behavior", () => {
    it("should return cached redirect on second call with same parameters", async () => {
      const content = "cached-system-recovery-content";
      const hash = await sha256(content);

      mockR2ListVersions("system", ["1.0.0"]);
      mockR2LegacyVersionWithContent(
        "system",
        "1.0.0",
        "update.img",
        content,
        await hash,
      );

      const res1 = await app.request(
        "/releases/system_recovery/latest",
        {},
        mockEnv,
      );
      expect(res1.status).toBe(302);
      expect(res1.headers.get("Location")).toBe(
        "https://cdn.test.com/system/1.0.0/update.img",
      );

      // Reset bucket with different data
      mockBucket.reset();
      mockR2ListVersions("system", ["2.0.0"]);
      mockR2LegacyVersionWithContent(
        "system",
        "2.0.0",
        "update.img",
        "new-content",
        await sha256("new-content"),
      );

      // Second call should return cached result
      const res2 = await app.request(
        "/releases/system_recovery/latest",
        {},
        mockEnv,
      );
      expect(res2.status).toBe(302);
      expect(res2.headers.get("Location")).toBe(
        "https://cdn.test.com/system/1.0.0/update.img",
      );
    });

    it("should use different cache keys for different SKUs", async () => {
      const content = "sku-cache-test-recovery";
      const hash = await sha256(content);

      mockR2ListVersions("system", ["1.0.0"]);
      mockR2LegacyVersionWithContent(
        "system",
        "1.0.0",
        "update.img",
        content,
        await hash,
      );

      const res1 = await app.request(
        "/releases/system_recovery/latest",
        {},
        mockEnv,
      );
      expect(res1.status).toBe(302);
      expect(res1.headers.get("Location")).toBe(
        "https://cdn.test.com/system/1.0.0/update.img",
      );

      mockBucket.reset();
      mockR2ListVersions("system", ["2.0.0"]);
      mockR2SkuVersionWithContent(
        "system",
        "2.0.0",
        "jetkvm-2",
        "update.img",
        content,
        await hash,
      );

      const res2 = await app.request(
        "/releases/system_recovery/latest?sku=jetkvm-2",
        {},
        mockEnv,
      );
      expect(res2.status).toBe(302);
      expect(res2.headers.get("Location")).toBe(
        "https://cdn.test.com/system/2.0.0/skus/jetkvm-2/update.img",
      );
    });
  });
});
