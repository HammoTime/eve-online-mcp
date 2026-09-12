import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
  truncate,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  StaticDataCache,
  defaultStaticDataDirectory,
  SDE_LATEST_URL,
} from "../src/static-data.js";
import { SkillImport, SkillStore } from "../src/skill-store.js";
import { skillFixture } from "./skill-fixtures.js";

const directories: string[] = [];
const releases: (() => void)[] = [];
const initialize = Reflect.get(StaticDataCache.prototype, "initialize");
beforeEach(() => {
  vi.spyOn(StaticDataCache.prototype, "initialize").mockImplementation(
    async function (this: StaticDataCache, refresh) {
      const result = await initialize.call(this, refresh);
      releases.push(result.release);
      return result;
    },
  );
});
afterEach(async () => {
  vi.restoreAllMocks();
  releases.splice(0).forEach((release) => {
    release();
  });
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "eve-sde-test-"));
  directories.push(directory);
  const fetcher = vi.fn<typeof fetch>();
  const now = vi.fn(() => Date.parse("2026-09-07T00:00:00Z"));
  const readArchive = vi.fn(
    (
      _path: string,
      metadata: Omit<
        ReturnType<typeof skillFixture>,
        "schemaVersion" | "types"
      >,
    ) =>
      Promise.resolve(
        new SkillImport(directory, metadata).fromCatalog({
          ...skillFixture(),
          ...metadata,
        }),
      ),
  );
  const options = { directory, fetchImplementation: fetcher, now, readArchive };
  return {
    directory,
    fetcher,
    now,
    readArchive,
    options,
    cache: new StaticDataCache(options),
  };
}
function manifest(build = 123) {
  return new Response(
    JSON.stringify({
      _key: "sde",
      buildNumber: build,
      releaseDate: "2026-09-01T00:00:00Z",
    }) + "\n",
    { headers: { etag: `"build-${build}"` } },
  );
}
function download(
  fetcher: ReturnType<typeof vi.fn<typeof fetch>>,
  build = 123,
) {
  fetcher
    .mockResolvedValueOnce(manifest(build))
    .mockResolvedValueOnce(new Response("archive"));
}
async function legacy(directory: string) {
  const catalog = skillFixture();
  const text = JSON.stringify({
    checkedAt: "2026-09-07T00:00:00Z",
    etag: '"legacy"',
    sha256: createHash("sha256").update(JSON.stringify(catalog)).digest("hex"),
    catalog,
  });
  await writeFile(join(directory, "catalog-v1.json"), text);
  await writeFile(join(directory, "sde-jsonl.zip"), "legacy archive");
  return text;
}
async function cacheFiles(directory: string) {
  return (await readdir(directory))
    .filter(
      (name) =>
        !/^skills-v1\.sqlite-(wal|shm)$/.test(name) &&
        name !== "sde-archives-v1",
    )
    .sort();
}

describe("official static data cache", () => {
  it("downloads fixed-origin data once, shares initialization, and reuses the validated disk index", async () => {
    const { cache, fetcher, directory, options, readArchive } = await setup();
    download(fetcher);
    const [first, concurrent] = await Promise.all([
      cache.initialize(),
      cache.initialize(),
    ]);
    expect(first.status).toEqual(concurrent.status);
    expect(first.catalog).not.toBe(concurrent.catalog);
    first.release();
    expect(concurrent.catalog.resolve("Mining").status).toBe("resolved");
    expect(first.status).toMatchObject({
      buildNumber: 123,
      stale: false,
      skillCount: 3,
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(readArchive).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[0]).toBe(SDE_LATEST_URL);
    expect(fetcher.mock.calls[1]?.[0]).toBe(
      "https://developers.eveonline.com/static-data/tranquility/eve-online-static-data-123-jsonl.zip",
    );
    for (const [, init] of fetcher.mock.calls)
      expect(init).toMatchObject({
        redirect: "error",
        headers: { "User-Agent": expect.any(String) },
      });
    expect(new SkillStore(directory).read()?.metadata).toEqual(
      first.catalog.metadata,
    );
    expect((await new StaticDataCache(options).initialize()).status).toEqual(
      first.status,
    );
    await cache.initialize();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(await cacheFiles(directory)).toEqual(["skills-v1.sqlite"]);
  });
  it("checks ETags after five minutes or on explicit refresh, without downloading unchanged archives", async () => {
    const { cache, fetcher, now } = await setup();
    download(fetcher);
    await cache.initialize();
    now.mockReturnValue(Date.parse("2026-09-07T00:06:00Z"));
    fetcher.mockResolvedValueOnce(new Response(null, { status: 304 }));
    expect((await cache.initialize()).status).toMatchObject({
      stale: false,
      checkedAt: "2026-09-07T00:06:00.000Z",
    });
    expect(fetcher.mock.calls[2]?.[1]?.headers).toMatchObject({
      "If-None-Match": '"build-123"',
    });
    fetcher.mockResolvedValueOnce(manifest());
    await cache.initialize(true);
    expect(fetcher).toHaveBeenCalledTimes(4);
  });
  it("updates to a validated newer build and refuses a downgrade", async () => {
    const { cache, fetcher } = await setup();
    download(fetcher);
    await cache.initialize();
    download(fetcher, 124);
    expect((await cache.initialize(true)).status).toMatchObject({
      buildNumber: 124,
      stale: false,
    });
    fetcher.mockResolvedValueOnce(manifest(123));
    expect((await cache.initialize(true)).status).toMatchObject({
      buildNumber: 124,
      stale: true,
      warning: expect.stringContaining("older"),
    });
  });
  it("does not accept an unconditional 304 as freshness evidence", async () => {
    const { cache, fetcher, now } = await setup();
    const latest = manifest();
    latest.headers.delete("etag");
    fetcher
      .mockResolvedValueOnce(latest)
      .mockResolvedValueOnce(new Response("archive"));
    const first = await cache.initialize();
    now.mockReturnValue(Date.parse("2026-09-07T00:06:00Z"));
    fetcher.mockResolvedValueOnce(new Response(null, { status: 304 }));
    expect((await cache.initialize(true)).status).toMatchObject({
      stale: true,
      checkedAt: first.status.checkedAt,
    });
  });

  it("retains a failed explicit-refresh warning during the existing cache interval", async () => {
    const { cache, fetcher } = await setup();
    download(fetcher);
    await cache.initialize();
    fetcher.mockRejectedValueOnce(new Error("Offline"));
    expect((await cache.initialize(true)).status.stale).toBe(true);
    expect((await cache.initialize()).status.stale).toBe(true);
    fetcher.mockResolvedValueOnce(new Response(null, { status: 304 }));
    expect((await cache.initialize(true)).status.stale).toBe(false);
  });
  it("keeps a labelled previous build after manifest or archive failure", async () => {
    const { cache, fetcher, readArchive, now, directory } = await setup();
    download(fetcher);
    await cache.initialize();
    now.mockReturnValue(Date.parse("2026-09-07T00:06:00Z"));
    fetcher.mockRejectedValueOnce(new Error("Offline"));
    expect((await cache.initialize()).status).toMatchObject({
      buildNumber: 123,
      stale: true,
    });
    download(fetcher, 124);
    readArchive.mockRejectedValueOnce(new Error("Bad archive"));
    expect((await cache.initialize()).status).toMatchObject({
      buildNumber: 123,
      stale: true,
    });
    expect(new SkillStore(directory).read()?.metadata.buildNumber).toBe(123);
    expect(await cacheFiles(directory)).toEqual(["skills-v1.sqlite"]);
  });
  it("imports validated legacy data once, preserving legacy files and using SQLite after restart", async () => {
    const { cache, fetcher, directory, options } = await setup();
    const text = await legacy(directory);
    const first = await cache.initialize();
    expect(first.catalog.resolve("Mining").status).toBe("resolved");
    expect(fetcher).not.toHaveBeenCalled();
    download(fetcher, 124);
    await cache.initialize(true);
    expect(
      (await new StaticDataCache(options).initialize()).status.buildNumber,
    ).toBe(124);
    expect(await readFile(join(directory, "catalog-v1.json"), "utf8")).toBe(
      text,
    );
    expect(await readFile(join(directory, "sde-jsonl.zip"), "utf8")).toBe(
      "legacy archive",
    );
    expect(await cacheFiles(directory)).toEqual([
      "catalog-v1.json",
      "sde-jsonl.zip",
      "skills-v1.sqlite",
    ]);
  });
  it("retries a failed first publication from the network, never from legacy in an initialized empty database", async () => {
    const { cache, fetcher, directory, options } = await setup();
    const text = await legacy(directory);
    const prepare = Reflect.get(DatabaseSync.prototype, "prepare");
    let failed = false;
    vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (
      this: DatabaseSync,
      sql,
    ) {
      const statement = prepare.call(this, sql);
      if (!failed && sql.startsWith("INSERT OR REPLACE INTO skill_catalog")) {
        failed = true;
        vi.spyOn(statement, "run").mockImplementationOnce(() => {
          throw new Error("synthetic INSERT failure");
        });
      }
      return statement;
    });
    await expect(cache.initialize()).rejects.toThrow("unavailable");
    const store = new SkillStore(directory);
    expect(store.exists()).toBe(true);
    expect(store.read()).toBeUndefined();
    expect(fetcher).not.toHaveBeenCalled();
    fetcher.mockRejectedValueOnce(new Error("offline"));
    await expect(new StaticDataCache(options).initialize()).rejects.toThrow(
      "unavailable",
    );
    expect(store.read()).toBeUndefined();
    download(fetcher, 124);
    expect(
      (await new StaticDataCache(options).initialize()).status.buildNumber,
    ).toBe(124);
    expect(fetcher.mock.calls[1]?.[1]?.headers).not.toHaveProperty(
      "If-None-Match",
    );
    expect(store.read()?.metadata.buildNumber).toBe(124);
    expect(await readFile(join(directory, "catalog-v1.json"), "utf8")).toBe(
      text,
    );
  });
  it.each(["checksum", "oversized", "source", "schema", "structure"])(
    "rebuilds an invalid legacy index (%s) without modifying it",
    async (failure) => {
      const { cache, fetcher, directory } = await setup();
      const text = await legacy(directory);
      const index = join(directory, "catalog-v1.json");
      if (failure === "oversized") await truncate(index, 40_000_001);
      else if (failure === "checksum")
        await writeFile(index, text.replace('"Mining"', '"Corrupted"'));
      else {
        const catalog = {
          ...skillFixture(),
          ...(failure === "source"
            ? { sourceUrl: "https://example.com/archive.zip" }
            : {}),
          ...(failure === "schema" ? { schemaVersion: 2 } : {}),
          ...(failure === "structure" ? { types: [] } : {}),
        };
        await writeFile(
          index,
          JSON.stringify({
            checkedAt: "2026-09-07T00:00:00Z",
            etag: null,
            catalog,
            sha256: createHash("sha256")
              .update(JSON.stringify(catalog))
              .digest("hex"),
          }),
        );
      }
      fetcher.mockRejectedValueOnce(new Error("Offline"));
      await expect(cache.initialize()).rejects.toThrow("unavailable");
      const before = await readFile(index);
      download(fetcher);
      expect((await cache.initialize()).catalog.resolve("Mining").status).toBe(
        "resolved",
      );
      // Deep equality enumerates millions of Buffer indices; compare bytes natively.
      expect((await readFile(index)).equals(before)).toBe(true);
    },
  );
  it.each([
    "checksum",
    "oversized",
    "future",
    "corrupt",
    "unversioned",
    "incomplete",
  ])(
    "never falls back to legacy or overwrites an invalid authoritative database (%s)",
    async (failure) => {
      const { cache, fetcher, directory, options } = await setup();
      const text = await legacy(directory);
      fetcher.mockResolvedValueOnce(manifest());
      await cache.initialize(true);
      releases.splice(0).forEach((release) => {
        release();
      });
      const index = join(directory, "skills-v1.sqlite");
      if (failure === "corrupt") await writeFile(index, "not a database");
      else {
        const db = new DatabaseSync(index);
        try {
          if (failure === "future") db.exec("PRAGMA user_version=3");
          else if (failure === "unversioned") db.exec("PRAGMA user_version=0");
          else if (failure === "incomplete")
            db.exec("DROP TABLE skill_catalog");
          else if (failure === "oversized")
            db.exec(
              "UPDATE skill_catalog SET etag = CAST(zeroblob(40000001) AS TEXT)",
            );
          else db.exec("UPDATE skill_catalog SET sha256 = 'invalid'");
        } finally {
          db.close();
        }
      }
      const before = await readFile(index);
      fetcher.mockClear();
      await expect(new StaticDataCache(options).initialize()).rejects.toThrow(
        "unavailable",
      );
      expect(fetcher).not.toHaveBeenCalled();
      expect((await readFile(index)).equals(before)).toBe(true);
      expect(await readFile(join(directory, "catalog-v1.json"), "utf8")).toBe(
        text,
      );
    },
  );
  it.each(["304", "same build", "new build"])(
    "fails honestly when the backing database is removed (%s)",
    async (response) => {
      const { cache, fetcher, directory, now } = await setup();
      download(fetcher);
      const first = await cache.initialize();
      first.release();
      const index = join(directory, "skills-v1.sqlite");
      await rm(index);
      await mkdir(index);
      now.mockReturnValue(Date.parse("2026-09-07T00:06:00Z"));
      if (response === "304")
        fetcher.mockResolvedValueOnce(new Response(null, { status: 304 }));
      else if (response === "same build")
        fetcher.mockResolvedValueOnce(manifest());
      else download(fetcher, 124);
      await expect(cache.initialize(true)).rejects.toThrow("unavailable");
      expect(await cacheFiles(directory)).toEqual(["skills-v1.sqlite"]);
    },
  );
  it("fails honestly when the cache directory becomes invalid", async () => {
    const { cache, fetcher, directory, options } = await setup();
    download(fetcher);
    const first = await cache.initialize();
    first.release();
    await rm(directory, { recursive: true });
    await writeFile(directory, "invalid directory");
    await expect(cache.initialize(true)).rejects.toThrow("unavailable");
    await expect(new StaticDataCache(options).initialize()).rejects.toThrow(
      "unavailable",
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("keeps publication/cleanup failures generic when the directory changes during parsing", async () => {
    const { cache, fetcher, directory, readArchive } = await setup();
    download(fetcher);
    const first = await cache.initialize();
    first.release();
    download(fetcher, 124);
    readArchive.mockImplementationOnce(async (_path, metadata) => {
      await rm(directory, { recursive: true });
      await writeFile(directory, "invalid directory");
      return new SkillImport(directory, metadata).fromCatalog({
        ...skillFixture(),
        ...metadata,
      });
    });
    await expect(cache.initialize(true)).rejects.toThrow("unavailable");
  });
  it.each(["304", "same build", "old download"])(
    "fences a stale process behind a newer publisher (%s)",
    async (response) => {
      const { cache, fetcher, directory, options, now, readArchive } =
        await setup();
      download(fetcher);
      await cache.initialize();
      const other = new StaticDataCache(options);
      await other.initialize();
      now.mockReturnValue(Date.parse("2026-09-07T00:06:00Z"));
      let release: (() => void) | undefined;
      let started: (() => void) | undefined;
      const pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      const waiting = new Promise<void>((resolve) => {
        started = resolve;
      });
      if (response === "old download") {
        download(fetcher, 124);
        readArchive.mockImplementationOnce(async (_path, metadata) => {
          started?.();
          await pending;
          return new SkillImport(directory, metadata).fromCatalog({
            ...skillFixture(),
            ...metadata,
          });
        });
      } else {
        fetcher.mockImplementationOnce(async () => {
          started?.();
          await pending;
          return response === "304"
            ? new Response(null, { status: 304 })
            : manifest();
        });
      }
      const stale = cache.initialize(true);
      await waiting;
      download(fetcher, 125);
      const winner = await other.initialize(true);
      now.mockReturnValue(Date.parse("2026-09-07T00:07:00Z"));
      release?.();
      const result = await stale;
      expect(result.status).toMatchObject({
        buildNumber: 125,
        checkedAt: winner.status.checkedAt,
        stale: true,
      });
      expect(new SkillStore(directory).read()?.metadata.buildNumber).toBe(125);
      expect((await new StaticDataCache(options).initialize()).status).toEqual(
        winner.status,
      );
    },
  );
  it("rejects conflicting same-build manifest identity without marking it fresh", async () => {
    const { cache, fetcher, now, directory } = await setup();
    download(fetcher);
    const first = await cache.initialize();
    now.mockReturnValue(Date.parse("2026-09-07T00:06:00Z"));
    fetcher.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          _key: "sde",
          buildNumber: 123,
          releaseDate: "2026-09-02T00:00:00Z",
        }),
      ),
    );
    expect((await cache.initialize(true)).status).toMatchObject({
      stale: true,
      checkedAt: first.status.checkedAt,
    });
    expect(new SkillStore(directory).read()?.checkedAt).toBe(
      first.status.checkedAt,
    );
  });
  it.each([NaN, Infinity, -1, 0, 1.5])(
    "rejects invalid archive budgets (%s)",
    async (maxArchiveBytes) => {
      const { options, fetcher } = await setup();
      download(fetcher);
      await expect(
        new StaticDataCache({ ...options, maxArchiveBytes }).initialize(),
      ).rejects.toThrow("validation failed");
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );
  it.each([
    new Response("no", { status: 503 }),
    new Response(null, { status: 304 }),
    new Response(null),
    new Response("{broken"),
    new Response("null\n{}\n"),
    new Response(
      JSON.stringify({
        _key: "sde",
        buildNumber: "../../evil",
        releaseDate: "invalid",
      }),
    ),
    new Response("x".repeat(65537)),
    new Response(
      [1, 2]
        .map(() =>
          JSON.stringify({
            _key: "sde",
            buildNumber: 123,
            releaseDate: "2026-09-01T00:00:00Z",
          }),
        )
        .join("\n"),
    ),
  ])("fails closed on missing or invalid manifest %#", async (response) => {
    const { cache, fetcher } = await setup();
    fetcher.mockResolvedValueOnce(response);
    await expect(cache.initialize()).rejects.toThrow("unavailable");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([
    new Response(null),
    new Response("failure", { status: 500 }),
    new Response("large", { headers: { "content-length": "100" } }),
    new Response("large"),
  ])("enforces successful bounded archive downloads %#", async (response) => {
    const { fetcher, options, directory } = await setup();
    fetcher.mockResolvedValueOnce(manifest()).mockResolvedValueOnce(response);
    await expect(
      new StaticDataCache({ ...options, maxArchiveBytes: 4 }).initialize(),
    ).rejects.toThrow("download or validation failed");
    expect(new SkillStore(directory).exists()).toBe(false);
    expect(
      (await readdir(directory)).filter((name) =>
        name.startsWith("skills-import"),
      ),
    ).toEqual([]);
  });
  it("uses trusted archive metadata and rejects a structurally invalid parsed archive", async () => {
    const { cache, fetcher, readArchive } = await setup();
    download(fetcher);
    readArchive.mockImplementationOnce(async (_path, metadata) => {
      const stage = new SkillImport((await setup()).directory, metadata);
      try {
        return stage.fromCatalog({ ...skillFixture(), types: [] });
      } catch (error) {
        stage.dispose();
        throw error;
      }
    });
    await expect(cache.initialize()).rejects.toThrow("validation failed");
    expect(readArchive).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        buildNumber: 123,
        sourceUrl: expect.stringContaining("developers.eveonline.com/"),
      }),
    );
  });
  it("selects platform-appropriate local paths with an environment override", () => {
    expect(
      defaultStaticDataDirectory({ EVE_SDE_CACHE_DIR: "/explicit" }, "linux"),
    ).toBe("/explicit");
    expect(
      defaultStaticDataDirectory({ LOCALAPPDATA: "/local" }, "win32"),
    ).toBe("/local/eve-online-mcp/sde");
    expect(defaultStaticDataDirectory({}, "win32")).toContain(
      "AppData/Local/eve-online-mcp/sde",
    );
    expect(defaultStaticDataDirectory({}, "darwin")).toContain(
      "Library/Caches/eve-online-mcp/sde",
    );
    expect(
      defaultStaticDataDirectory({ XDG_CACHE_HOME: "/xdg" }, "linux"),
    ).toBe("/xdg/eve-online-mcp/sde");
    expect(defaultStaticDataDirectory({}, "linux")).toContain(
      ".cache/eve-online-mcp/sde",
    );
  });
});
