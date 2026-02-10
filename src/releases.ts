import type { Context } from "hono";
import type { AppType } from "./env";
import { BadRequestError, InternalServerError, NotFoundError } from "./errors";
import semver from "semver";
import { LRUCache } from "lru-cache";
import { getDeviceRolloutBucket, toSemverRange, verifyHash } from "./helpers";
import { z, ZodError } from "zod";

const DEFAULT_SKU = "jetkvm-v2";

/** Query param schema builders for common patterns */
const queryString = () =>
  z
    .string()
    .optional()
    .transform(v => v || undefined);
const queryBoolean = () =>
  z
    .string()
    .optional()
    .transform(v => v === "true");
const querySku = () =>
  z
    .string()
    .optional()
    .transform(v => v || DEFAULT_SKU);

/**
 * Schema for redirect endpoints (RetrieveLatestApp, RetrieveLatestSystemRecovery).
 * Only needs prerelease flag and SKU (defaults to jetkvm-v2).
 */
const latestQuerySchema = z.object({
  prerelease: queryBoolean(),
  sku: querySku(),
});

type LatestQuery = z.infer<typeof latestQuerySchema>;

/**
 * Schema for the main Retrieve endpoint.
 * Requires deviceId and includes version constraints and forceUpdate flag.
 */
const retrieveQuerySchema = z.object({
  deviceId: z.string({ error: "Device ID is required" }).min(1, "Device ID is required"),
  prerelease: queryBoolean(),
  appVersion: queryString(),
  systemVersion: queryString(),
  sku: querySku(),
  forceUpdate: queryBoolean(),
});

type RetrieveQuery = z.infer<typeof retrieveQuerySchema>;

/**
 * Parses query parameters and converts ZodError to BadRequestError.
 */
function parseQuery<T>(schema: z.ZodSchema<T>, c: Context<AppType>): T {
  try {
    return schema.parse(c.req.query());
  } catch (error) {
    if (error instanceof ZodError) {
      const message = error.issues.map((e: z.ZodIssue) => e.message).join(", ");
      throw new BadRequestError(message);
    }
    throw error;
  }
}

export interface ReleaseMetadata {
  version: string;
  url: string;
  hash: string;
  _cachedAt?: number;
  _maxSatisfying?: string;
}

const releaseCache = new LRUCache<string, ReleaseMetadata>({
  max: 1000,
  ttl: 5 * 60 * 1000, // 5 minutes
});

const redirectCache = new LRUCache<string, string>({
  max: 1000,
  ttl: 5 * 60 * 1000, // 5 minutes
});

/** Clear all caches - useful for testing */
export function clearCaches() {
  releaseCache.clear();
  redirectCache.clear();
}

// ---------------------------------------------------------------------------
// R2 helpers
// ---------------------------------------------------------------------------

/**
 * Checks if an object exists in R2 by attempting a head request.
 */
async function r2ObjectExists(bucket: R2Bucket, key: string): Promise<boolean> {
  const obj = await bucket.head(key);
  return obj !== null;
}

/**
 * Checks if a version was uploaded with SKU folder structure.
 * Returns true if any skus/ subfolder exists for this version.
 */
async function versionHasSkuSupport(
  bucket: R2Bucket,
  prefix: "app" | "system",
  version: string,
): Promise<boolean> {
  const response = await bucket.list({
    prefix: `${prefix}/${version}/skus/`,
    limit: 1,
  });
  return response.objects.length > 0;
}

/**
 * Resolves the artifact path for a given version and SKU.
 *
 * For versions with SKU support (skus/ folder exists):
 *   - Uses the provided SKU
 *   - Fails if the requested SKU is not available
 *
 * For legacy versions (no skus/ folder):
 *   - Returns legacy path for default SKU
 *   - Fails for non-default SKUs because legacy firmware predates
 *     that hardware and may not be compatible
 *
 * @param bucket - The R2 bucket
 * @param prefix - The prefix folder ("app" or "system")
 * @param version - The version string
 * @param sku - SKU identifier (defaults to jetkvm-v2 from schema)
 * @param artifactOverride - Optional artifact name override (defaults based on prefix)
 */
async function resolveArtifactPath(
  bucket: R2Bucket,
  prefix: "app" | "system",
  version: string,
  sku: string,
  artifactOverride?: string,
): Promise<string> {
  const artifact = artifactOverride ?? (prefix === "app" ? "jetkvm_app" : "system.tar");

  if (await versionHasSkuSupport(bucket, prefix, version)) {
    const skuPath = `${prefix}/${version}/skus/${sku}/${artifact}`;

    if (await r2ObjectExists(bucket, skuPath)) {
      return skuPath;
    }

    throw new NotFoundError(`SKU "${sku}" is not available for version ${version}`);
  }

  // SKU defaults to "jetkvm-v2" via zod schema when not provided.
  //
  // For legacy versions (pre-SKU folder structure), we only serve the default SKU.
  // This prevents newer hardware variants from rolling back to old firmware
  // that may not have compatible binaries for their hardware.
  if (sku === DEFAULT_SKU) {
    return `${prefix}/${version}/${artifact}`;
  }

  throw new NotFoundError(
    `Version ${version} predates SKU support and cannot serve SKU "${sku}"`,
  );
}

async function getLatestVersion(
  bucket: R2Bucket,
  cdnUrl: string,
  prefix: "app" | "system",
  includePrerelease: boolean,
  maxSatisfying: string = "*",
  sku: string,
): Promise<ReleaseMetadata> {
  const cacheKey = `${prefix}-${includePrerelease}-${maxSatisfying}-${sku}`;
  const cached = releaseCache.get(cacheKey);
  if (cached) return cached;

  const response = await bucket.list({
    prefix: prefix + "/",
    delimiter: "/",
  });

  if (!response.delimitedPrefixes || response.delimitedPrefixes.length === 0) {
    throw new NotFoundError(`No versions found under prefix ${prefix}`);
  }

  // Extract version folder names
  let versions = response.delimitedPrefixes
    .map(p => p.split("/")[1])
    .filter(Boolean)
    .filter(v => semver.valid(v));

  if (versions.length === 0) {
    throw new NotFoundError(`No valid versions found under prefix ${prefix}`);
  }

  // Get the latest version, optionally including prerelease versions
  const latestVersion = semver.maxSatisfying(versions, maxSatisfying, {
    includePrerelease,
  }) as string;
  if (!latestVersion) {
    throw new NotFoundError(
      `No version found under prefix ${prefix} that satisfies ${maxSatisfying}`,
    );
  }

  const selectedPath = await resolveArtifactPath(bucket, prefix, latestVersion, sku);
  const url = `${cdnUrl}/${selectedPath}`;

  const hashObj = await bucket.get(`${selectedPath}.sha256`);
  if (!hashObj) {
    throw new NotFoundError(`Hash file not found for ${selectedPath}`);
  }
  const hash = await hashObj.text();

  // Cache the release metadata
  const release = {
    version: latestVersion,
    url,
    hash,
    _cachedAt: Date.now(),
    _maxSatisfying: maxSatisfying,
  };
  releaseCache.set(cacheKey, release);
  return release;
}

interface Release {
  appVersion: string;
  appUrl: string;
  appHash: string;
  appCachedAt?: number;
  appMaxSatisfying?: string;

  systemVersion: string;
  systemUrl: string;
  systemHash: string;
  systemCachedAt?: number;
  systemMaxSatisfying?: string;
}

function setAppRelease(release: Release, appRelease: ReleaseMetadata) {
  release.appVersion = appRelease.version;
  release.appUrl = appRelease.url;
  release.appHash = appRelease.hash;
  release.appCachedAt = appRelease._cachedAt;
  release.appMaxSatisfying = appRelease._maxSatisfying;
}

function setSystemRelease(release: Release, systemRelease: ReleaseMetadata) {
  release.systemVersion = systemRelease.version;
  release.systemUrl = systemRelease.url;
  release.systemHash = systemRelease.hash;
  release.systemCachedAt = systemRelease._cachedAt;
  release.systemMaxSatisfying = systemRelease._maxSatisfying;
}

function toRelease(
  appRelease?: ReleaseMetadata,
  systemRelease?: ReleaseMetadata,
): Release {
  const release: Partial<Release> = {};
  if (appRelease) setAppRelease(release as Release, appRelease);
  if (systemRelease) setSystemRelease(release as Release, systemRelease);
  return release as Release;
}

async function getReleaseFromR2(
  bucket: R2Bucket,
  cdnUrl: string,
  includePrerelease: boolean,
  {
    appVersion,
    systemVersion,
    sku,
  }: { appVersion?: string; systemVersion?: string; sku: string },
): Promise<Release> {
  const [appRelease, systemRelease] = await Promise.all([
    getLatestVersion(bucket, cdnUrl, "app", includePrerelease, appVersion, sku),
    getLatestVersion(bucket, cdnUrl, "system", includePrerelease, systemVersion, sku),
  ]);

  return toRelease(appRelease, systemRelease);
}

async function isDeviceEligibleForLatestRelease(
  rolloutPercentage: number,
  deviceId: string,
): Promise<boolean> {
  if (rolloutPercentage === 100) return true;
  return (await getDeviceRolloutBucket(deviceId)) < rolloutPercentage;
}

async function getDefaultRelease(c: Context<AppType>, type: "app" | "system") {
  const prisma = c.get("prisma");
  const rolledOutReleases = await prisma.release.findMany({
    where: { rolloutPercentage: 100, type },
    select: { version: true, url: true, hash: true },
  });

  if (rolledOutReleases.length === 0) {
    throw new InternalServerError(`No default release found for type ${type}`);
  }

  // Get the latest default version from the rolled out releases
  const latestVersion = semver.maxSatisfying(
    rolledOutReleases.map(r => r.version),
    "*",
  ) as string;

  // Get the release with the latest default version
  const latestDefaultRelease = rolledOutReleases.find(r => r.version === latestVersion);

  if (!latestDefaultRelease) {
    throw new InternalServerError(`No default release found for type ${type}`);
  }

  return latestDefaultRelease;
}

export async function Retrieve(c: Context<AppType>) {
  const query = parseQuery(retrieveQuerySchema, c);
  const prisma = c.get("prisma");
  const bucket = c.env.R2_BUCKET;
  const cdnUrl = c.env.R2_CDN_URL;

  const appVersion = toSemverRange(query.appVersion);
  const systemVersion = toSemverRange(query.systemVersion);
  const skipRollout = appVersion !== "*" || systemVersion !== "*";

  // Get the latest release from R2
  let remoteRelease: Release;
  try {
    remoteRelease = await getReleaseFromR2(bucket, cdnUrl, query.prerelease, {
      appVersion,
      systemVersion,
      sku: query.sku,
    });
  } catch (error) {
    console.error(error);
    if (error instanceof NotFoundError) {
      throw error;
    }
    throw new InternalServerError(`Failed to get the latest release from R2: ${error}`);
  }

  // If the request is for prereleases, ignore the rollout percentage and just return the latest release
  // This is useful for the OTA updater to get the latest prerelease version
  // This also prevents us from storing the rollout percentage for prerelease versions

  // If the version isn't a wildcard, we skip the rollout percentage check
  if (query.prerelease || skipRollout) {
    return c.json(remoteRelease);
  }

  // Fetch or create the latest app release
  const latestAppRelease = await prisma.release.upsert({
    where: { version_type: { version: remoteRelease.appVersion, type: "app" } },
    update: {},
    create: {
      version: remoteRelease.appVersion,
      rolloutPercentage: 10,
      url: remoteRelease.appUrl,
      type: "app",
      hash: remoteRelease.appHash,
    },
    select: { version: true, url: true, rolloutPercentage: true, hash: true },
  });

  // Fetch or create the latest system release
  const latestSystemRelease = await prisma.release.upsert({
    where: { version_type: { version: remoteRelease.systemVersion, type: "system" } },
    update: {},
    create: {
      version: remoteRelease.systemVersion,
      rolloutPercentage: 10,
      url: remoteRelease.systemUrl,
      type: "system",
      hash: remoteRelease.systemHash,
    },
    select: { version: true, url: true, rolloutPercentage: true, hash: true },
  });

  /*
    Return the latest release if forceUpdate is true, bypassing rollout rules.
    This occurs when a user manually checks for updates in the app UI.
    Background update checks follow the normal rollout percentage rules, to ensure controlled, gradual deployment of updates.
  */
  if (query.forceUpdate) {
    return c.json(toRelease(latestAppRelease, latestSystemRelease));
  }

  const defaultAppRelease = await getDefaultRelease(c, "app");
  const defaultSystemRelease = await getDefaultRelease(c, "system");

  const responseJson = toRelease(defaultAppRelease, defaultSystemRelease);

  if (
    await isDeviceEligibleForLatestRelease(
      latestAppRelease.rolloutPercentage,
      query.deviceId,
    )
  ) {
    setAppRelease(responseJson, latestAppRelease);
  }

  if (
    await isDeviceEligibleForLatestRelease(
      latestSystemRelease.rolloutPercentage,
      query.deviceId,
    )
  ) {
    setSystemRelease(responseJson, latestSystemRelease);
  }

  return c.json(responseJson);
}

function cachedRedirect(
  cachedKey: (query: LatestQuery) => string,
  callback: (c: Context<AppType>, query: LatestQuery) => Promise<string>,
) {
  return async (c: Context<AppType>) => {
    const query = parseQuery(latestQuerySchema, c);
    const cacheKey = cachedKey(query);
    let result = redirectCache.get(cacheKey);
    if (!result) {
      result = await callback(c, query);
      redirectCache.set(cacheKey, result);
    }
    return c.redirect(result, 302);
  };
}

/**
 * Generates a cache key for release endpoints based on prefix, prerelease flag, and SKU.
 */
function releaseCacheKey(prefix: string, query: LatestQuery): string {
  return `${prefix}-${query.prerelease ? "pre" : "stable"}-${query.sku}`;
}

export const RetrieveLatestSystemRecovery = cachedRedirect(
  query => releaseCacheKey("system-recovery", query),
  async (c, query) => {
    const bucket = c.env.R2_BUCKET;
    const cdnUrl = c.env.R2_CDN_URL;

    // Get the latest system recovery image from R2. It's stored in the system/ folder.
    const response = await bucket.list({
      prefix: "system/",
      delimiter: "/",
    });

    // Extract version folder names
    if (!response.delimitedPrefixes || response.delimitedPrefixes.length === 0) {
      throw new NotFoundError(`No versions found under prefix system recovery image`);
    }

    // Get the latest version
    const versions = response.delimitedPrefixes
      .map(p => p.split("/")[1])
      .filter(Boolean)
      .filter(v => semver.valid(v));

    const latestVersion = semver.maxSatisfying(versions, "*", {
      includePrerelease: query.prerelease,
    }) as string;

    if (!latestVersion) {
      throw new NotFoundError("No valid system recovery versions found");
    }

    // Resolve the artifact path with SKU support (using update.img for recovery)
    const artifactPath = await resolveArtifactPath(
      bucket,
      "system",
      latestVersion,
      query.sku,
      "update.img",
    );

    const [firmwareFile, hashFile] = await Promise.all([
      bucket.get(artifactPath),
      bucket.get(`${artifactPath}.sha256`),
    ]);

    if (!firmwareFile || !hashFile) {
      throw new NotFoundError(
        `No system recovery image or hash file not found for version ${latestVersion}`,
      );
    }

    const firmwareBody = await firmwareFile.arrayBuffer();
    const hashText = await hashFile.text();

    await verifyHash(firmwareBody, hashText, "system recovery image hash does not match");

    console.log("system recovery image hash matches", latestVersion);

    return `${cdnUrl}/${artifactPath}`;
  },
);

export const RetrieveLatestApp = cachedRedirect(
  query => releaseCacheKey("app", query),
  async (c, query) => {
    const bucket = c.env.R2_BUCKET;
    const cdnUrl = c.env.R2_CDN_URL;

    // Get the latest version
    const response = await bucket.list({
      prefix: "app/",
      delimiter: "/",
    });

    if (!response.delimitedPrefixes || response.delimitedPrefixes.length === 0) {
      throw new NotFoundError("No app versions found");
    }

    const versions = response.delimitedPrefixes
      .map(p => p.split("/")[1])
      .filter(v => semver.valid(v));

    const latestVersion = semver.maxSatisfying(versions, "*", {
      includePrerelease: query.prerelease,
    }) as string;

    if (!latestVersion) {
      throw new NotFoundError("No valid app versions found");
    }

    // Resolve the artifact path with SKU support
    const artifactPath = await resolveArtifactPath(bucket, "app", latestVersion, query.sku);

    // Get the app file and its hash
    const [appFile, hashFile] = await Promise.all([
      bucket.get(artifactPath),
      bucket.get(`${artifactPath}.sha256`),
    ]);

    if (!appFile || !hashFile) {
      throw new NotFoundError(`App or hash file not found for version ${latestVersion}`);
    }

    const appBody = await appFile.arrayBuffer();
    const hashText = await hashFile.text();

    await verifyHash(appBody, hashText, "app hash does not match");

    console.log("App hash matches", latestVersion);
    return `${cdnUrl}/${artifactPath}`;
  },
);
