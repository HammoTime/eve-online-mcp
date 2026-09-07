import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
  truncate,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  StaticDataCache,
  defaultStaticDataDirectory,
  SDE_LATEST_URL,
} from "../src/static-data.js";
import { skillFixture } from "./skill-fixtures.js";

const directories: string[] = [];
afterEach(async () => {
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
    ) => Promise.resolve({ ...skillFixture(), ...metadata }),
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

describe("official static data cache", () => {
  it("downloads fixed-origin data once, shares initialization, and reuses the validated disk index", async () => {
    const { cache, fetcher, directory, options, readArchive } = await setup();
    download(fetcher);
    const [first, concurrent] = await Promise.all([
      cache.initialize(),
      cache.initialize(),
    ]);
    expect(first).toEqual(concurrent);
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
    expect(await readFile(join(directory, "sde-jsonl.zip"), "utf8")).toBe(
      "archive",
    );
    expect((await new StaticDataCache(options).initialize()).status).toEqual(
      first.status,
    );
    await cache.initialize();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect((await readdir(directory)).sort()).toEqual([
      "catalog-v1.json",
      "sde-jsonl.zip",
    ]);
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
    expect(await readFile(join(directory, "sde-jsonl.zip"), "utf8")).toBe(
      "archive",
    );
    expect((await readdir(directory)).sort()).toEqual([
      "catalog-v1.json",
      "sde-jsonl.zip",
    ]);
  });
  it("rebuilds corrupted or oversized indexes; an invalid cache is never a usable stale fallback", async () => {
    const { cache, fetcher, directory, options } = await setup();
    download(fetcher);
    await cache.initialize();
    const index = join(directory, "catalog-v1.json");
    const text = await readFile(index, "utf8");
    await writeFile(index, text.replace('"Mining"', '"Corrupted"'));
    fetcher.mockRejectedValueOnce(new Error("Offline"));
    await expect(new StaticDataCache(options).initialize()).rejects.toThrow(
      "unavailable",
    );
    download(fetcher);
    expect(
      (await new StaticDataCache(options).initialize()).catalog.resolve(
        "Mining",
      ).status,
    ).toBe("resolved");
    await truncate(index, 40_000_001);
    download(fetcher);
    await new StaticDataCache(options).initialize();
    expect(fetcher).toHaveBeenCalledTimes(7);
  });
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
    expect(await readdir(directory)).toEqual([]);
  });
  it("uses trusted archive metadata and rejects a structurally invalid parsed archive", async () => {
    const { cache, fetcher, readArchive } = await setup();
    download(fetcher);
    readArchive.mockResolvedValueOnce({ ...skillFixture(), types: [] });
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
