import { beforeAll, afterEach, afterAll, vi } from "vitest";

// =========================================================================
// Mock R2 Bucket
// =========================================================================

export class MockR2Bucket {
  private store = new Map<string, Uint8Array>();

  reset() {
    this.store.clear();
  }

  putText(key: string, text: string) {
    this.store.set(key, new TextEncoder().encode(text));
  }

  putBinary(key: string, data: Uint8Array | ArrayBuffer) {
    this.store.set(key, data instanceof Uint8Array ? data : new Uint8Array(data));
  }

  async list(
    options?: { prefix?: string; delimiter?: string; limit?: number },
  ): Promise<any> {
    const prefix = options?.prefix ?? "";
    const delimiter = options?.delimiter;
    const limit = options?.limit ?? 1000;

    const matchingKeys = [...this.store.keys()]
      .filter((k) => k.startsWith(prefix))
      .sort();

    if (delimiter) {
      const prefixSet = new Set<string>();
      const objects: any[] = [];

      for (const key of matchingKeys) {
        const remainder = key.slice(prefix.length);
        const delimIndex = remainder.indexOf(delimiter);
        if (delimIndex >= 0) {
          prefixSet.add(prefix + remainder.slice(0, delimIndex + 1));
        } else {
          objects.push({ key, size: this.store.get(key)!.byteLength });
        }
      }

      return {
        objects: objects.slice(0, limit),
        delimitedPrefixes: [...prefixSet].sort(),
        truncated: false,
      };
    }

    return {
      objects: matchingKeys
        .slice(0, limit)
        .map((key) => ({ key, size: this.store.get(key)!.byteLength })),
      delimitedPrefixes: [],
      truncated: false,
    };
  }

  async get(key: string): Promise<any | null> {
    const data = this.store.get(key);
    if (!data) return null;

    const buf = data.buffer.slice(
      data.byteOffset,
      data.byteOffset + data.byteLength,
    );

    return {
      key,
      size: data.byteLength,
      httpMetadata: {},
      customMetadata: {},
      text: async () => new TextDecoder().decode(data),
      arrayBuffer: async () => buf,
      json: async () => JSON.parse(new TextDecoder().decode(data)),
      blob: async () => new Blob([new Uint8Array(data)]),
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(data));
          controller.close();
        },
      }),
      bodyUsed: false,
    };
  }

  async head(key: string): Promise<any | null> {
    const data = this.store.get(key);
    if (!data) return null;
    return { key, size: data.byteLength };
  }

  async put(key: string, value: any): Promise<any> {
    if (typeof value === "string") {
      this.store.set(key, new TextEncoder().encode(value));
    } else if (value instanceof ArrayBuffer) {
      this.store.set(key, new Uint8Array(value));
    } else if (value instanceof Uint8Array) {
      this.store.set(key, value);
    }
    return { key };
  }

  async delete(keys: string | string[]): Promise<void> {
    const keysArr = Array.isArray(keys) ? keys : [keys];
    for (const key of keysArr) this.store.delete(key);
  }
}

// =========================================================================
// Mock Release Store (replaces real DB for release tests)
// =========================================================================

export interface MockRelease {
  version: string;
  type: string;
  rolloutPercentage: number;
  url: string;
  hash: string;
}

export class MockReleaseStore {
  releases: MockRelease[] = [];

  reset() {
    this.releases = [];
  }

  seed(data: MockRelease[]) {
    this.releases = data.map((r) => ({ ...r }));
  }

  /** Returns a mock prisma-like object with release operations backed by this store. */
  createPrismaMock(): any {
    const self = this;
    return {
      release: {
        findMany: vi.fn(async (args?: any) => {
          let results = [...self.releases];
          const where = args?.where;
          if (where) {
            if (where.rolloutPercentage !== undefined) {
              results = results.filter(
                (r) => r.rolloutPercentage === where.rolloutPercentage,
              );
            }
            if (where.type !== undefined) {
              results = results.filter((r) => r.type === where.type);
            }
          }
          const select = args?.select;
          if (select) {
            return results.map((r) => {
              const obj: any = {};
              for (const key of Object.keys(select)) {
                if (select[key]) obj[key] = (r as any)[key];
              }
              return obj;
            });
          }
          return results;
        }),

        findUnique: vi.fn(async (args: any) => {
          const where = args?.where;
          if (where?.version_type) {
            const { version, type } = where.version_type;
            const found = self.releases.find(
              (r) => r.version === version && r.type === type,
            );
            return found ? { ...found } : null;
          }
          return null;
        }),

        upsert: vi.fn(async (args: any) => {
          const { version, type } = args.where.version_type;
          let existing = self.releases.find(
            (r) => r.version === version && r.type === type,
          );

          if (existing) {
            if (args.update && Object.keys(args.update).length > 0) {
              Object.assign(existing, args.update);
            }
          } else {
            existing = { ...args.create };
            self.releases.push(existing!);
          }

          const select = args?.select;
          if (select) {
            const obj: any = {};
            for (const key of Object.keys(select)) {
              if (select[key]) obj[key] = (existing as any)[key];
            }
            return obj;
          }
          return { ...existing };
        }),

        create: vi.fn(async (args: any) => {
          const data = { ...args.data };
          self.releases.push(data);
          return data;
        }),

        deleteMany: vi.fn(async (args?: any) => {
          const where = args?.where;
          if (!where || Object.keys(where).length === 0) {
            const count = self.releases.length;
            self.releases = [];
            return { count };
          }
          if (where.version) {
            const before = self.releases.length;
            self.releases = self.releases.filter(
              (r) => r.version !== where.version,
            );
            return { count: before - self.releases.length };
          }
          return { count: 0 };
        }),
      },
    };
  }
}

// =========================================================================
// Shared instances & seed data
// =========================================================================

export const mockBucket = new MockR2Bucket();
export const releaseStore = new MockReleaseStore();

export const seedReleases: MockRelease[] = [
  // App releases
  {
    version: "1.0.0",
    type: "app",
    rolloutPercentage: 100,
    url: "https://cdn.test.com/app/1.0.0/jetkvm_app",
    hash: "abc123hash100",
  },
  {
    version: "1.1.0",
    type: "app",
    rolloutPercentage: 100,
    url: "https://cdn.test.com/app/1.1.0/jetkvm_app",
    hash: "abc123hash110",
  },
  {
    version: "1.2.0",
    type: "app",
    rolloutPercentage: 10,
    url: "https://cdn.test.com/app/1.2.0/jetkvm_app",
    hash: "abc123hash120",
  },
  // System releases
  {
    version: "1.0.0",
    type: "system",
    rolloutPercentage: 100,
    url: "https://cdn.test.com/system/1.0.0/system.tar",
    hash: "sys123hash100",
  },
  {
    version: "1.1.0",
    type: "system",
    rolloutPercentage: 100,
    url: "https://cdn.test.com/system/1.1.0/system.tar",
    hash: "sys123hash110",
  },
  {
    version: "1.2.0",
    type: "system",
    rolloutPercentage: 10,
    url: "https://cdn.test.com/system/1.2.0/system.tar",
    hash: "sys123hash120",
  },
];

export async function setRollout(
  version: string,
  type: "app" | "system",
  percentage: number,
) {
  const existing = releaseStore.releases.find(
    (r) => r.version === version && r.type === type,
  );
  if (existing) {
    existing.rolloutPercentage = percentage;
  } else {
    releaseStore.releases.push({
      version,
      type,
      rolloutPercentage: percentage,
      url: `https://cdn.test.com/${type}/${version}/${type === "app" ? "jetkvm_app" : "system.tar"}`,
      hash: `test-hash-${version}-${type}`,
    });
  }
}

export async function resetToSeedData() {
  releaseStore.seed(seedReleases);
}

// =========================================================================
// Global hooks
// =========================================================================

beforeAll(async () => {
  releaseStore.seed(seedReleases);
});

afterEach(() => {
  mockBucket.reset();
  return resetToSeedData();
});

afterAll(() => {
  // Nothing to clean up with in-memory stores
});
