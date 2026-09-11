import { createHash } from "node:crypto";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalMapDataSource, readMapArchive } from "../src/map-data.js";
import { LocalMapStore, MAP_DATABASE_FILE } from "../src/map-store.js";
import { SDE_LATEST_URL } from "../src/static-data.js";
import {
  mapRequestSchema,
  type MapData,
} from "../lib/src/cartography/types.js";
import { MAP_DATA_LIMITS, MapCatalog } from "../lib/src/cartography/catalog.js";
import { readPreparedMapScene } from "../lib/src/cartography/prepared.js";
import { renderMap, renderPreparedMap } from "../lib/src/cartography/render.js";
import { zipFixture } from "./skill-fixtures.js";

const directories: string[] = [];
const epoch = Date.parse("2026-09-09T00:00:00Z");
const releaseDate = "2026-09-01T00:00:00Z";
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
function fixture(metadata: Parameters<typeof readMapArchive>[1]): MapData {
  return {
    ...metadata,
    schemaVersion: 1,
    systems: [
      {
        id: 100,
        name: "First",
        regionId: 1,
        constellationId: 10,
        position: { x: 1, y: 2, z: 3 },
        securityStatus: 0.449,
      },
      {
        id: 101,
        name: "Second",
        regionId: 1,
        constellationId: 10,
        position: { x: 4, y: 5, z: 6 },
        position2D: { x: 7, y: 8 },
        securityStatus: -0.01,
      },
    ],
    regions: [{ id: 1, name: "Region" }],
    constellations: [{ id: 10, name: "Constellation", regionId: 1 }],
    gates: [
      { id: 1000, systemId: 100, destinationId: 101, destinationGateId: 1001 },
    ],
  };
}
const metadata = {
  buildNumber: 123,
  releaseDate,
  sourceUrl:
    "https://developers.eveonline.com/static-data/tranquility/eve-online-static-data-123-jsonl.zip",
  fetchedAt: new Date(epoch).toISOString(),
};
function archiveEntries(): [string, string][] {
  const data = fixture(metadata);
  return [
    [
      "mapSolarSystems.jsonl",
      data.systems
        .map((system) =>
          JSON.stringify({
            _key: system.id,
            name: { en: system.name },
            regionID: system.regionId,
            constellationID: system.constellationId,
            position: system.position,
            position2D: system.position2D,
            securityStatus: system.securityStatus,
          }),
        )
        .join("\n"),
    ],
    ["mapRegions.jsonl", JSON.stringify({ _key: 1, name: { en: "Region" } })],
    [
      "mapConstellations.jsonl",
      JSON.stringify({ _key: 10, name: { en: "Constellation" }, regionID: 1 }),
    ],
    [
      "mapStargates.jsonl",
      JSON.stringify({
        _key: 1000,
        solarSystemID: 100,
        destination: { solarSystemID: 101, stargateID: 1001 },
      }),
    ],
  ];
}
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "eve-map-test-"));
  directories.push(directory);
  const fetcher = vi.fn<typeof fetch>();
  const now = vi.fn(() => epoch);
  const readArchive = vi.fn(
    (_path: string, details: Parameters<typeof readMapArchive>[1]) =>
      Promise.resolve(fixture(details)),
  );
  const options = { directory, fetchImplementation: fetcher, now, readArchive };
  return {
    directory,
    fetcher,
    now,
    readArchive,
    options,
    source: new LocalMapDataSource(options),
  };
}
function manifest(buildNumber = 123, date = releaseDate) {
  return new Response(
    JSON.stringify({ _key: "sde", buildNumber, releaseDate: date }) + "\n",
    { headers: { etag: `"build-${buildNumber}"` } },
  );
}
function download(
  fetcher: ReturnType<typeof vi.fn<typeof fetch>>,
  build = 123,
  body = "archive",
) {
  fetcher
    .mockResolvedValueOnce(manifest(build))
    .mockResolvedValueOnce(new Response(body));
}
function digest(text: string | Buffer) {
  return createHash("sha256").update(text).digest("hex");
}
function archiveName(build = 123, body: string | Buffer = "archive") {
  return `map-sde-${build}-${digest(body)}.zip`;
}
async function legacy(directory: string, body: string | Buffer = "archive") {
  const catalog = fixture(metadata);
  const text = JSON.stringify({
    schemaVersion: 1,
    checkedAt: metadata.fetchedAt,
    etag: '"build-123"',
    sha256: digest(JSON.stringify(catalog)),
    archiveSha256: digest(body),
    catalog,
  });
  await writeFile(join(directory, "map-catalog-v1.json"), text);
  await writeFile(join(directory, archiveName(123, body)), body);
  return text;
}
const request = () =>
  mapRequestSchema.parse({
    boundary: { kind: "neighborhood", center: "Second" },
    pointsOfInterest: [],
    preview: "none",
  });
function sql(directory: string, operation: (db: DatabaseSync) => void) {
  const db = new DatabaseSync(join(directory, MAP_DATABASE_FILE));
  try {
    operation(db);
  } finally {
    db.close();
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function cacheFiles(directory: string) {
  // SQLite may leave WAL coordination files after read-only connections close.
  return (await readdir(directory))
    .filter(
      (name) =>
        name !== `${MAP_DATABASE_FILE}-wal` &&
        name !== `${MAP_DATABASE_FILE}-shm`,
    )
    .sort();
}

describe("local map source", () => {
  it("single-flights compatibility promise/catalog identity and reuses validated SQLite data", async () => {
    const { source, options, fetcher, directory, readArchive } = await setup();
    await writeFile(join(directory, "catalog-v1.json"), "skill-index-sentinel");
    await writeFile(join(directory, "sde-jsonl.zip"), "untrusted-legacy-build");
    download(fetcher);
    const firstPromise = source.initialize();
    expect(source.initialize(true)).toBe(firstPromise);
    const first = await firstPromise;
    expect(first.status).toEqual({
      ...metadata,
      checkedAt: metadata.fetchedAt,
      stale: false,
    });
    expect((await source.initialize()).catalog).toBe(first.catalog);
    expect(first.catalog.resolveSystem(100).securityStatus).toBe(0.449);
    expect(readArchive).toHaveBeenCalledTimes(1);
    expect(readArchive).toHaveBeenCalledWith(
      expect.stringMatching(/map-archive-.*\.tmp$/),
      metadata,
    );
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      SDE_LATEST_URL,
      metadata.sourceUrl,
    ]);
    for (const [, init] of fetcher.mock.calls) {
      expect(init).toMatchObject({
        redirect: "error",
        headers: { "User-Agent": expect.any(String) },
        signal: expect.any(AbortSignal),
      });
      expect(new Headers(init?.headers).has("authorization")).toBe(false);
    }
    const store = new LocalMapStore(directory);
    expect(store.read()).toEqual({
      source: metadata,
      checkedAt: metadata.fetchedAt,
      etag: '"build-123"',
      archiveSha256: digest("archive"),
    });
    expect(store.loadCatalog().catalog.data).toEqual(first.catalog.data);
    const reloaded = await new LocalMapDataSource(options).initialize();
    expect(reloaded.catalog.data).toEqual(first.catalog.data);
    expect(reloaded.status).toEqual(first.status);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(await readFile(join(directory, "catalog-v1.json"), "utf8")).toBe(
      "skill-index-sentinel",
    );
    expect(await readFile(join(directory, "sde-jsonl.zip"), "utf8")).toBe(
      "untrusted-legacy-build",
    );
    expect(await cacheFiles(directory)).toEqual(
      ["catalog-v1.json", MAP_DATABASE_FILE, "sde-jsonl.zip"].sort(),
    );
  });
  it("checks at five minutes with ETags and preserves catalog identity for 304/same-build responses", async () => {
    const { source, fetcher, now } = await setup();
    download(fetcher);
    const first = await source.initialize();
    now.mockReturnValue(epoch + 299_999);
    expect((await source.initialize()).catalog).toBe(first.catalog);
    expect(fetcher).toHaveBeenCalledTimes(2);
    now.mockReturnValue(epoch + 300_000);
    fetcher.mockResolvedValueOnce(new Response(null, { status: 304 }));
    const checked = await source.initialize();
    expect(checked.catalog).toBe(first.catalog);
    expect(checked.status).toMatchObject({
      stale: false,
      checkedAt: "2026-09-09T00:05:00.000Z",
      fetchedAt: metadata.fetchedAt,
    });
    expect(fetcher.mock.calls[2]?.[1]?.headers).toMatchObject({
      "If-None-Match": '"build-123"',
    });
    fetcher.mockResolvedValueOnce(manifest());
    expect((await source.initialize(true)).catalog).toBe(first.catalog);
    expect(fetcher).toHaveBeenCalledTimes(4);
    now.mockReturnValue(epoch - 1);
    fetcher.mockResolvedValueOnce(manifest());
    await source.initialize();
    expect(fetcher).toHaveBeenCalledTimes(5);
  });
  it("atomically publishes new SQLite builds without retaining ZIPs and rejects downgrades", async () => {
    const { source, fetcher, directory } = await setup();
    download(fetcher);
    const first = await source.initialize();
    download(fetcher, 124, "new archive");
    const second = await source.initialize(true);
    expect(second.catalog).not.toBe(first.catalog);
    expect(second.status.buildNumber).toBe(124);
    expect(first.catalog.data.buildNumber).toBe(123);
    const store = new LocalMapStore(directory);
    const saved = store.read();
    expect(saved).toMatchObject({
      source: { buildNumber: 124 },
      archiveSha256: digest("new archive"),
    });
    expect(store.loadCatalog().catalog.data).toEqual(second.catalog.data);
    expect(await cacheFiles(directory)).toEqual([MAP_DATABASE_FILE]);
    fetcher.mockResolvedValueOnce(manifest(123));
    const downgrade = await source.initialize(true);
    expect(downgrade.catalog).toBe(second.catalog);
    expect(downgrade.status).toMatchObject({
      stale: true,
      warning: expect.stringContaining("older"),
    });
    expect(store.read()).toEqual(saved);
  });
  it("preserves last-good data and warning across failed checks, downloads, validation and same-build identity conflicts", async () => {
    const { source, fetcher, readArchive, directory } = await setup();
    download(fetcher);
    const first = await source.initialize();
    const store = new LocalMapStore(directory);
    const snapshotBefore = store.read();
    fetcher.mockRejectedValueOnce(new Error("PRIVATE transport detail"));
    const offline = await source.initialize(true);
    expect(offline.catalog).toBe(first.catalog);
    expect(offline.status).toMatchObject({
      stale: true,
      checkedAt: first.status.checkedAt,
    });
    expect(offline.status.warning).not.toContain("PRIVATE");
    expect((await source.initialize()).status).toEqual(offline.status);
    download(fetcher, 124);
    readArchive.mockRejectedValueOnce(new Error("Bad ZIP"));
    expect((await source.initialize(true)).catalog).toBe(first.catalog);
    fetcher
      .mockResolvedValueOnce(manifest(124))
      .mockRejectedValueOnce(new Error("Offline"));
    expect((await source.initialize(true)).status.stale).toBe(true);
    fetcher.mockResolvedValueOnce(manifest(123, "2026-09-02T00:00:00Z"));
    expect((await source.initialize(true)).status.stale).toBe(true);
    expect(store.read()).toEqual(snapshotBefore);
    expect(store.loadCatalog().catalog.data).toEqual(first.catalog.data);
    expect(await cacheFiles(directory)).toEqual([MAP_DATABASE_FILE]);
    fetcher.mockResolvedValueOnce(new Response(null, { status: 304 }));
    expect((await source.initialize(true)).status.stale).toBe(false);
  });
  it("falls back to a validated disk build while offline after restart", async () => {
    const { source, options, fetcher, now } = await setup();
    download(fetcher);
    const first = await source.initialize();
    now.mockReturnValue(epoch + 300_000);
    fetcher.mockRejectedValueOnce(new Error("Offline"));
    const fallback = await new LocalMapDataSource(options).initialize();
    expect(fallback.catalog.data).toEqual(first.catalog.data);
    expect(fallback.status.stale).toBe(true);
  });
  it("prepares incoming-gate neighborhoods from SQLite across warm calls and restart with zero catalog loads or ESI", async () => {
    const { source, options, fetcher, readArchive, directory } = await setup();
    const load = vi
      .spyOn(LocalMapStore.prototype, "loadCatalog")
      .mockImplementation(() => {
        throw new Error("Prepared requests must not load a full catalog");
      });
    const esi = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("Unexpected network request"));
    download(fetcher);
    const cold = await source.prepare(request());
    const warm = await source.prepare(request());
    // An obsolete legacy file must not be consulted once SQLite exists.
    await writeFile(
      join(directory, "map-catalog-v1.json"),
      "PRIVATE obsolete index",
    );
    const restarted = new LocalMapDataSource(options);
    const disk = await restarted.prepare(request());
    for (const result of [cold, warm, disk]) {
      expect(result.status).toEqual({
        ...metadata,
        checkedAt: metadata.fetchedAt,
        stale: false,
      });
      expect(renderPreparedMap(result.scene)).toEqual(
        renderMap(new MapCatalog(fixture(metadata)), request()),
      );
      expect(
        readPreparedMapScene(result.scene).systems.map(({ id }) => id),
      ).toEqual([100, 101]);
    }
    expect(load).not.toHaveBeenCalled();
    expect(esi).not.toHaveBeenCalled();
    expect(readArchive).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      SDE_LATEST_URL,
      metadata.sourceUrl,
    ]);
    expect(
      Object.values(source).some((value) => value instanceof MapCatalog),
    ).toBe(false);
    expect(
      Object.values(restarted).some((value) => value instanceof MapCatalog),
    ).toBe(false);
  });
  it("migrates bounded checksum-validated legacy input offline, leaves it untouched, and restarts without catalog loads", async () => {
    const { source, options, fetcher, now, readArchive, directory } =
      await setup();
    const archive = zipFixture(archiveEntries());
    const text = await legacy(directory, archive);
    const load = vi.spyOn(LocalMapStore.prototype, "loadCatalog");
    now.mockReturnValue(epoch + 300_000);
    fetcher.mockRejectedValue(new Error("PRIVATE offline details"));
    const result = await source.prepare(request());
    expect(result.status).toMatchObject({
      ...metadata,
      checkedAt: metadata.fetchedAt,
      stale: true,
    });
    expect(JSON.stringify(result.status)).not.toContain("PRIVATE");
    expect(new LocalMapStore(directory).read()).toEqual({
      source: metadata,
      checkedAt: metadata.fetchedAt,
      etag: '"build-123"',
      archiveSha256: digest(archive),
    });
    const disk = await new LocalMapDataSource(options).prepare(request());
    expect(disk.status).toEqual(result.status);
    expect(renderPreparedMap(disk.scene)).toEqual(
      renderPreparedMap(result.scene),
    );
    expect(load).not.toHaveBeenCalled();
    expect(readArchive).not.toHaveBeenCalled();
    expect(
      Object.values(source).some((value) => value instanceof MapCatalog),
    ).toBe(false);
    download(fetcher, 124);
    expect((await source.prepare(request())).status).toMatchObject({
      buildNumber: 124,
      stale: false,
    });
    expect(await readFile(join(directory, "map-catalog-v1.json"), "utf8")).toBe(
      text,
    );
    expect(await readFile(join(directory, archiveName(123, archive)))).toEqual(
      archive,
    );
    expect(await cacheFiles(directory)).toEqual(
      [
        MAP_DATABASE_FILE,
        "map-catalog-v1.json",
        archiveName(123, archive),
      ].sort(),
    );
  });
  it("validates requests and pre-aborts before filesystem, SQLite or download work", async () => {
    const { source, fetcher, directory } = await setup();
    const read = vi.spyOn(LocalMapStore.prototype, "read");
    const prepare = vi.spyOn(LocalMapStore.prototype, "prepare");
    await expect(
      source.prepare({
        ...request(),
        boundary: { kind: "systems", systems: [] },
      }),
    ).rejects.toMatchObject({ code: "INVALID_MAP_REQUEST" });
    const reason = new Error("Caller cancelled");
    await expect(
      source.prepare(request(), AbortSignal.abort(reason)),
    ).rejects.toBe(reason);
    expect(read).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
    expect(await readdir(directory)).toEqual([]);
  });
  it("cancels only one waiter while prepare and compatibility initialize share a single download", async () => {
    const { source, fetcher, readArchive } = await setup();
    const started = deferred<undefined>();
    const response = deferred<Response>();
    fetcher
      .mockImplementationOnce(() => {
        started.resolve(undefined);
        return response.promise;
      })
      .mockResolvedValueOnce(new Response("archive"));
    const controller = new AbortController();
    const cancelled = source.prepare(request(), controller.signal);
    const prepared = source.prepare(request());
    const initialized = source.initialize(true);
    expect(source.initialize()).toBe(initialized);
    await started.promise;
    const reason = new Error("Caller cancelled");
    controller.abort(reason);
    await expect(cancelled).rejects.toBe(reason);
    expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
    response.resolve(manifest());
    const [result, compatibility] = await Promise.all([prepared, initialized]);
    expect(result.status).toEqual(compatibility.status);
    expect(renderPreparedMap(result.scene)).toEqual(
      renderMap(compatibility.catalog, request()),
    );
    expect((await source.initialize()).catalog).toBe(compatibility.catalog);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(readArchive).toHaveBeenCalledTimes(1);
  });
  it("rechecks cancellation after parsing before starting shared initialization", async () => {
    const { source, fetcher, directory } = await setup();
    const read = vi.spyOn(LocalMapStore.prototype, "read");
    const prepare = vi.spyOn(LocalMapStore.prototype, "prepare");
    const controller = new AbortController();
    const reason = new Error("Caller cancelled during parsing");
    const input = {
      ...request(),
      get boundary() {
        controller.abort(reason);
        return { kind: "neighborhood", center: "Second", jumps: 1 } as const;
      },
    };
    await expect(source.prepare(input, controller.signal)).rejects.toBe(reason);
    expect(read).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
    expect(await readdir(directory)).toEqual([]);
  });
  it("consumes a shared initialization rejection after its sole waiter cancels and can retry", async () => {
    const { source, fetcher, readArchive } = await setup();
    const started = deferred<undefined>();
    const response = deferred<Response>();
    fetcher.mockImplementationOnce(() => {
      started.resolve(undefined);
      return response.promise;
    });
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const controller = new AbortController();
      const cancelled = source.prepare(request(), controller.signal);
      await started.promise;
      const reason = new Error("Caller cancelled");
      controller.abort(reason);
      await expect(cancelled).rejects.toBe(reason);
      expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
      response.resolve(new Response("Unavailable", { status: 503 }));
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(unhandled).not.toHaveBeenCalled();
      expect(readArchive).not.toHaveBeenCalled();
      download(fetcher);
      expect((await source.prepare(request())).status.stale).toBe(false);
      expect(fetcher).toHaveBeenCalledTimes(3);
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });
  it.each(["initialize", "prepare"] as const)(
    "uses the authoritative newer snapshot when an older %s download finishes last",
    async (method) => {
      const { source, options, fetcher, readArchive, now, directory } =
        await setup();
      const started = deferred<undefined>();
      const parsed = deferred<MapData>();
      readArchive.mockImplementationOnce(() => {
        started.resolve(undefined);
        return parsed.promise;
      });
      const load = vi.spyOn(LocalMapStore.prototype, "loadCatalog");
      download(fetcher);
      const older =
        method === "initialize"
          ? source.initialize()
          : source.prepare(request());
      await started.promise;
      const newerFetch = vi.fn<typeof fetch>();
      download(newerFetch, 124, "new archive");
      const newer = await new LocalMapDataSource({
        ...options,
        fetchImplementation: newerFetch,
        now: () => epoch + 300_000,
      }).prepare(request());
      const store = new LocalMapStore(directory);
      const authoritative = store.read();
      now.mockReturnValue(epoch + 600_000);
      parsed.resolve(fixture(metadata));
      const result = await older;
      expect(result.status).toEqual({
        ...newer.status,
        stale: true,
        warning:
          "Map cache changed during refresh; retained the validated stored build.",
      });
      if ("scene" in result)
        expect(renderPreparedMap(result.scene)).toEqual(
          renderPreparedMap(newer.scene),
        );
      else
        expect(result.catalog.data).toMatchObject({
          buildNumber: 124,
          fetchedAt: newer.status.fetchedAt,
        });
      expect(store.read()).toEqual(authoritative);
      expect(load).toHaveBeenCalledTimes(method === "initialize" ? 1 : 0);
      expect(await cacheFiles(directory)).toEqual([MAP_DATABASE_FILE]);
    },
  );
  it.each([304, 200])(
    "does not apply a delayed %s check or its ETag to a newer generation",
    async (status) => {
      const { source, options, fetcher, now, directory } = await setup();
      download(fetcher);
      await source.prepare(request());
      now.mockReturnValue(epoch + 300_000);
      const started = deferred<undefined>();
      const response = deferred<Response>();
      fetcher.mockImplementationOnce(() => {
        started.resolve(undefined);
        return response.promise;
      });
      const delayed = source.prepare(request());
      await started.promise;
      const newerFetch = vi.fn<typeof fetch>();
      download(newerFetch, 124, "new archive");
      const newer = await new LocalMapDataSource({
        ...options,
        fetchImplementation: newerFetch,
        now: () => epoch + 400_000,
      }).prepare(request());
      const store = new LocalMapStore(directory);
      const authoritative = store.read();
      now.mockReturnValue(epoch + 600_000);
      response.resolve(
        status === 304 ? new Response(null, { status }) : manifest(),
      );
      const result = await delayed;
      expect(result.status).toMatchObject({
        ...newer.status,
        stale: true,
        warning: expect.stringContaining("changed"),
      });
      expect(renderPreparedMap(result.scene)).toEqual(
        renderPreparedMap(newer.scene),
      );
      expect(store.read()).toEqual(authoritative);
      expect(store.read()?.etag).toBe('"build-124"');
      expect(fetcher.mock.calls[2]?.[1]?.headers).toMatchObject({
        "If-None-Match": '"build-123"',
      });
    },
  );
  it.each(["corrupt", "empty", "future", "identity"])(
    "never falls back to legacy or overwrites an existing %s database",
    async (kind) => {
      const { source, options, fetcher, directory, readArchive } =
        await setup();
      await legacy(directory);
      if (kind === "corrupt" || kind === "empty")
        await writeFile(
          join(directory, MAP_DATABASE_FILE),
          kind === "empty" ? "" : "PRIVATE corrupt database",
        );
      else {
        new LocalMapStore(directory).publish(
          new MapCatalog(fixture(metadata)),
          {
            checkedAt: metadata.fetchedAt,
            etag: '"build-123"',
            archiveSha256: digest("archive"),
          },
        );
        sql(directory, (db) => {
          if (kind === "future") db.exec("PRAGMA user_version = 2");
          else
            db.exec(
              "UPDATE active SET snapshot = json_set(snapshot, '$.source.sourceUrl', 'https://example.invalid/PRIVATE')",
            );
        });
      }
      const before = await readFile(join(directory, MAP_DATABASE_FILE));
      const index = await readFile(join(directory, "map-catalog-v1.json"));
      for (const operation of [
        () => source.initialize(),
        () => new LocalMapDataSource(options).prepare(request()),
      ]) {
        await expect(operation()).rejects.toMatchObject({
          code: "MAP_DATA_UNAVAILABLE",
          details: {},
        });
      }
      expect(fetcher).not.toHaveBeenCalled();
      expect(readArchive).not.toHaveBeenCalled();
      expect(await readFile(join(directory, MAP_DATABASE_FILE))).toEqual(
        before,
      );
      expect(await readFile(join(directory, "map-catalog-v1.json"))).toEqual(
        index,
      );
      expect(await readFile(join(directory, archiveName()), "utf8")).toBe(
        "archive",
      );
    },
  );
  it("fails closed on corrupt selected rows with stale last-good metadata instead of returning a scene", async () => {
    const { source, options, fetcher, now, directory } = await setup();
    download(fetcher);
    const first = await source.prepare(request());
    sql(directory, (db) => {
      db.exec("UPDATE systems SET outgoing_gate_count = 0 WHERE id = 100");
    });
    const load = vi.spyOn(LocalMapStore.prototype, "loadCatalog");
    now.mockReturnValue(epoch + 300_000);
    fetcher.mockRejectedValue(new Error("PRIVATE offline path"));
    for (const current of [source, new LocalMapDataSource(options)]) {
      await expect(current.prepare(request())).rejects.toMatchObject({
        code: "MAP_DATA_UNAVAILABLE",
        details: {
          status: {
            ...first.status,
            stale: true,
            warning: expect.stringContaining("could not be read"),
          },
        },
      });
    }
    expect(load).not.toHaveBeenCalled();
    expect(new LocalMapStore(directory).read()?.checkedAt).toBe(
      first.status.checkedAt,
    );
  });
  it.each([
    "catalog",
    "digest",
    "archive",
    "missing-archive",
    "identity",
    "oversized",
    "metadata",
    "archive-digest",
    "archive-oversized",
    "invalid-graph",
  ])("never migrates corrupt legacy %s as fallback", async (kind) => {
    const { options, fetcher, directory } = await setup();
    await legacy(directory);
    const path = join(directory, "map-catalog-v1.json");
    const text = await readFile(path, "utf8");
    if (kind === "catalog")
      await writeFile(path, text.replace('"First"', '"Wrong"'));
    if (kind === "digest") {
      const index = JSON.parse(text);
      index.sha256 = "not-a-digest";
      await writeFile(path, JSON.stringify(index));
    }
    if (kind === "identity") {
      const index = JSON.parse(text);
      index.catalog.buildNumber = 999;
      index.sha256 = digest(JSON.stringify(index.catalog));
      await writeFile(path, JSON.stringify(index));
    }
    if (["metadata", "archive-digest", "invalid-graph"].includes(kind)) {
      const index = JSON.parse(text);
      if (kind === "metadata") index.checkedAt = "invalid";
      if (kind === "archive-digest") index.archiveSha256 = "not-a-digest";
      if (kind === "invalid-graph") {
        index.catalog.systems = [];
        index.sha256 = digest(JSON.stringify(index.catalog));
      }
      await writeFile(path, JSON.stringify(index));
    }
    if (kind === "archive")
      await writeFile(join(directory, archiveName()), "corrupt");
    if (kind === "missing-archive") await rm(join(directory, archiveName()));
    if (kind === "oversized") await truncate(path, 64_000_001);
    const before = await cacheFiles(directory);
    fetcher.mockRejectedValueOnce(new Error("Offline"));
    await expect(
      new LocalMapDataSource({
        ...options,
        ...(kind === "archive-oversized" ? { maxArchiveBytes: 4 } : {}),
      }).prepare(request()),
    ).rejects.toMatchObject({ code: "MAP_DATA_UNAVAILABLE" });
    expect(await cacheFiles(directory)).toEqual(before);
  });
  it("replaces unusable legacy input with SQLite without altering even corrupt legacy files", async () => {
    const { source, fetcher, directory } = await setup();
    await legacy(directory);
    await writeFile(join(directory, "map-catalog-v1.json"), "broken");
    await writeFile(join(directory, archiveName()), "corrupt");
    download(fetcher);
    expect((await source.prepare(request())).status.stale).toBe(false);
    expect(new LocalMapStore(directory).read()?.archiveSha256).toBe(
      digest("archive"),
    );
    expect(await readFile(join(directory, "map-catalog-v1.json"), "utf8")).toBe(
      "broken",
    );
    expect(await readFile(join(directory, archiveName()), "utf8")).toBe(
      "corrupt",
    );
  });
  it("concurrent independent writers publish only complete, matching SQLite snapshots", async () => {
    const { options, fetcher, directory, readArchive } = await setup();
    const parsed = deferred<undefined>();
    let readers = 0;
    readArchive.mockImplementation(async (_path, details) => {
      if (++readers === 2) parsed.resolve(undefined);
      await parsed.promise;
      return fixture(details);
    });
    fetcher.mockImplementation((url) =>
      Promise.resolve(
        url === SDE_LATEST_URL ? manifest() : new Response("archive"),
      ),
    );
    const results = await Promise.all([
      new LocalMapDataSource(options).initialize(),
      new LocalMapDataSource(options).initialize(),
    ]);
    expect(results[0].catalog.data).toEqual(results[1].catalog.data);
    const disk = await new LocalMapDataSource(options).initialize();
    expect(disk.status.stale).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(await cacheFiles(directory)).toEqual([MAP_DATABASE_FILE]);
  });
  it("does not swap last-good state or checkedAt when SQLite touch or publication fails", async () => {
    const { source, fetcher, directory, now } = await setup();
    download(fetcher);
    const first = await source.initialize();
    const store = new LocalMapStore(directory);
    const before = store.read();
    now.mockReturnValue(epoch + 300_000);
    vi.spyOn(LocalMapStore.prototype, "touch").mockImplementationOnce(() => {
      throw new Error("PRIVATE touch failure");
    });
    fetcher.mockResolvedValueOnce(new Response(null, { status: 304 }));
    expect((await source.initialize(true)).status.stale).toBe(true);
    expect(store.read()).toEqual(before);
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Forwarded with the active SQLite connection via call(this) below.
    const prepare = DatabaseSync.prototype.prepare;
    const failure = vi
      .spyOn(DatabaseSync.prototype, "prepare")
      .mockImplementation(function (this: DatabaseSync, query) {
        const statement = prepare.call(this, query);
        if (query.startsWith("INSERT INTO active"))
          vi.spyOn(statement, "run").mockImplementation(() => {
            throw new Error("PRIVATE publication failure");
          });
        return statement;
      });
    download(fetcher, 124, "next");
    const failed = await source.initialize(true);
    failure.mockRestore();
    expect(failed.catalog).toBe(first.catalog);
    expect(failed.status).toMatchObject({
      buildNumber: 123,
      checkedAt: first.status.checkedAt,
      stale: true,
    });
    expect(JSON.stringify(failed.status)).not.toContain("PRIVATE");
    expect(store.read()).toEqual(before);
    expect(store.loadCatalog().catalog.data).toEqual(first.catalog.data);
    fetcher.mockRejectedValueOnce(new Error("Offline"));
    const prepared = await source.prepare(request());
    expect(prepared.status).toEqual(failed.status);
    expect(renderPreparedMap(prepared.scene)).toEqual(
      renderMap(first.catalog, request()),
    );
    expect(
      (await readdir(directory)).some((name) => name.endsWith(".tmp")),
    ).toBe(false);
  });
  it("handles invalid cache directories without exposing filesystem details", async () => {
    const { directory, options } = await setup();
    const file = join(directory, "file");
    await writeFile(file, "x");
    await expect(
      new LocalMapDataSource({ ...options, directory: file }).initialize(),
    ).rejects.toMatchObject({ code: "MAP_DATA_UNAVAILABLE" });
  });
  it.each([
    () => new Response("no", { status: 503 }),
    () => new Response(null, { status: 304 }),
    () => new Response(null),
    () => new Response("{broken"),
    () => new Response("null\n{}\n"),
    () =>
      new Response(
        JSON.stringify({ _key: "sde", buildNumber: "../../evil", releaseDate }),
      ),
    () => new Response("x".repeat(65_537)),
    () =>
      new Response(
        [1, 2]
          .map(() =>
            JSON.stringify({ _key: "sde", buildNumber: 123, releaseDate }),
          )
          .join("\n"),
      ),
    () =>
      new Response(
        JSON.stringify({ _key: "sde", buildNumber: 123, releaseDate }),
        { headers: { etag: "x".repeat(1025) } },
      ),
  ])(
    "fails closed on malformed or unavailable manifests %#",
    async (response) => {
      const { source, fetcher } = await setup();
      fetcher.mockResolvedValueOnce(response());
      await expect(source.initialize()).rejects.toMatchObject({
        code: "MAP_DATA_UNAVAILABLE",
      });
      expect(fetcher).toHaveBeenCalledTimes(1);
      download(fetcher);
      expect((await source.initialize()).status.stale).toBe(false);
    },
  );
  it.each([
    () => new Response(null),
    () => new Response("failure", { status: 500 }),
    () => new Response("x", { headers: { "content-length": "5" } }),
    () => new Response("large", { headers: { "content-length": "1" } }),
    () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(3));
            controller.enqueue(new Uint8Array(3));
            controller.close();
          },
        }),
      ),
    () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error("Broken body"));
          },
        }),
      ),
  ])(
    "bounds streamed downloads regardless of content-length and cleans partial files %#",
    async (response) => {
      const { options, fetcher, directory, readArchive } = await setup();
      fetcher
        .mockResolvedValueOnce(manifest())
        .mockResolvedValueOnce(response());
      await expect(
        new LocalMapDataSource({ ...options, maxArchiveBytes: 4 }).initialize(),
      ).rejects.toMatchObject({ code: "MAP_DATA_UNAVAILABLE" });
      expect(readArchive).not.toHaveBeenCalled();
      expect(await readdir(directory)).toEqual([]);
    },
  );
  it.each([
    "buildNumber",
    "releaseDate",
    "sourceUrl",
    "fetchedAt",
    "systems",
  ] as const)(
    "rejects reader output with wrong %s before publication",
    async (field) => {
      const { source, fetcher, readArchive, directory } = await setup();
      download(fetcher);
      const data = fixture(metadata);
      if (field === "buildNumber") data.buildNumber = 999;
      else if (field === "systems") data.systems = [];
      else data[field] = "wrong";
      readArchive.mockResolvedValueOnce(data);
      await expect(source.initialize()).rejects.toMatchObject({
        code: "MAP_DATA_UNAVAILABLE",
      });
      expect(await readdir(directory)).toEqual([]);
    },
  );
  it.each([0, -1, NaN, Infinity, 1.5, 256_000_001])(
    "rejects unsafe download-limit overrides %s",
    (maxArchiveBytes) => {
      expect(() => new LocalMapDataSource({ maxArchiveBytes })).toThrow(
        "Invalid map archive byte limit",
      );
    },
  );
  it("does not let an injected reader rewrite the trusted build metadata", async () => {
    const { source, fetcher, readArchive, directory } = await setup();
    download(fetcher);
    readArchive.mockImplementationOnce((_path, details) => {
      expect(Object.isFrozen(details)).toBe(true);
      details.buildNumber = 999;
      return Promise.resolve(fixture(details));
    });
    await expect(source.initialize()).rejects.toMatchObject({
      code: "MAP_DATA_UNAVAILABLE",
    });
    expect(await readdir(directory)).toEqual([]);
  });
});

describe("streaming map ZIP adapter", () => {
  async function parse(archive: Buffer) {
    const { directory } = await setup();
    const path = join(directory, "fixture.zip");
    await writeFile(path, archive);
    return readMapArchive(path, metadata);
  }
  it("streams exact CCP entries, ignores unrelated content, and retains raw metadata", async () => {
    expect(
      await parse(
        zipFixture([
          ...archiveEntries().reverse(),
          ["other.jsonl", "not json"],
          ["nested/mapRegions.jsonl", "not json"],
        ]),
      ),
    ).toEqual(fixture(metadata));
  });
  it("uses the real archive reader in the source without any network service", async () => {
    const { options, fetcher } = await setup();
    fetcher
      .mockResolvedValueOnce(manifest())
      .mockResolvedValueOnce(
        new Response(new Uint8Array(zipFixture(archiveEntries()))),
      );
    const result = await new LocalMapDataSource({
      ...options,
      readArchive: readMapArchive,
    }).initialize();
    expect(result.catalog.data).toEqual(fixture(metadata));
    expect(result.catalog.hasGate(101, 100)).toBe(false);
  });
  it("rejects missing/nested required entries, duplicate entries, unsafe ZIP paths and invalid JSON", async () => {
    await expect(parse(zipFixture(archiveEntries().slice(1)))).rejects.toThrow(
      "missing required",
    );
    await expect(
      parse(
        zipFixture(
          archiveEntries().map(([name, text]) => [`nested/${name}`, text]),
        ),
      ),
    ).rejects.toThrow("missing required");
    await expect(
      parse(zipFixture([...archiveEntries(), ...archiveEntries()])),
    ).rejects.toThrow("Duplicate");
    await expect(
      parse(zipFixture([...archiveEntries(), ["../escape", "x"]])),
    ).rejects.toMatchObject({ code: "MAP_DATA_INVALID" });
    await expect(
      parse(zipFixture([["mapRegions.jsonl", "not JSON"]])),
    ).rejects.toMatchObject({ code: "MAP_DATA_INVALID" });
    await expect(parse(Buffer.from("not a ZIP"))).rejects.toMatchObject({
      code: "MAP_DATA_INVALID",
    });
  });
  it("bounds ZIP central-directory enumeration and advertised uncompressed entry sizes", async () => {
    await expect(
      parse(
        zipFixture(
          Array.from({ length: MAP_DATA_LIMITS.entries + 1 }, (_, index) => [
            `ignored-${index}`,
            "",
          ]),
        ),
      ),
    ).rejects.toMatchObject({ code: "MAP_DATA_LIMIT" });
    const zip = zipFixture([["mapRegions.jsonl", "x"]]);
    zip.writeUInt32LE(MAP_DATA_LIMITS.entryBytes + 1, 18);
    zip.writeUInt32LE(MAP_DATA_LIMITS.entryBytes + 1, 22);
    const central = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    zip.writeUInt32LE(MAP_DATA_LIMITS.entryBytes + 1, central + 20);
    zip.writeUInt32LE(MAP_DATA_LIMITS.entryBytes + 1, central + 24);
    await expect(parse(zip)).rejects.toMatchObject({ code: "MAP_DATA_LIMIT" });
  });
});
