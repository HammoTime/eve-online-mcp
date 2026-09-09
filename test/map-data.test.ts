import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalMapDataSource, readMapArchive } from "../src/map-data.js";
import { SDE_LATEST_URL } from "../src/static-data.js";
import type { MapData } from "../lib/src/cartography/types.js";
import { MAP_DATA_LIMITS } from "../lib/src/cartography/catalog.js";
import { zipFixture } from "./skill-fixtures.js";

const directories: string[] = [];
const epoch = Date.parse("2026-09-09T00:00:00Z");
const releaseDate = "2026-09-01T00:00:00Z";
afterEach(async () => {
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
function digest(text: string) {
  return createHash("sha256").update(text).digest("hex");
}
function archiveName(build = 123, body = "archive") {
  return `map-sde-${build}-${digest(body)}.zip`;
}

describe("local map source", () => {
  it("single-flights exact promise/catalog identity and reuses a checksum-validated disk index", async () => {
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
    expect(await readFile(join(directory, archiveName()), "utf8")).toBe(
      "archive",
    );
    const index = JSON.parse(
      await readFile(join(directory, "map-catalog-v1.json"), "utf8"),
    );
    expect(index.sha256).toBe(digest(JSON.stringify(first.catalog.data)));
    expect(index.archiveSha256).toBe(digest("archive"));
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
    expect((await readdir(directory)).sort()).toEqual(
      [
        "catalog-v1.json",
        "map-catalog-v1.json",
        archiveName(),
        "sde-jsonl.zip",
      ].sort(),
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
  it("publishes new immutable build archives, retains older snapshots, and rejects downgrades", async () => {
    const { source, fetcher, directory } = await setup();
    download(fetcher);
    const first = await source.initialize();
    download(fetcher, 124, "new archive");
    const second = await source.initialize(true);
    expect(second.catalog).not.toBe(first.catalog);
    expect(second.status.buildNumber).toBe(124);
    expect(first.catalog.data.buildNumber).toBe(123);
    expect(await readFile(join(directory, archiveName()), "utf8")).toBe(
      "archive",
    );
    expect(
      await readFile(join(directory, archiveName(124, "new archive")), "utf8"),
    ).toBe("new archive");
    fetcher.mockResolvedValueOnce(manifest(123));
    const downgrade = await source.initialize(true);
    expect(downgrade.catalog).toBe(second.catalog);
    expect(downgrade.status).toMatchObject({
      stale: true,
      warning: expect.stringContaining("older"),
    });
  });
  it("preserves last-good data and warning across failed checks, downloads, validation and same-build identity conflicts", async () => {
    const { source, fetcher, readArchive, directory } = await setup();
    download(fetcher);
    const first = await source.initialize();
    const indexBefore = await readFile(
      join(directory, "map-catalog-v1.json"),
      "utf8",
    );
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
    expect(await readFile(join(directory, "map-catalog-v1.json"), "utf8")).toBe(
      indexBefore,
    );
    expect((await readdir(directory)).sort()).toEqual(
      ["map-catalog-v1.json", archiveName()].sort(),
    );
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
  it.each([
    "catalog",
    "digest",
    "archive",
    "missing-archive",
    "identity",
    "oversized",
  ])("never uses corrupt %s as fallback", async (kind) => {
    const { source, options, fetcher, directory } = await setup();
    download(fetcher);
    await source.initialize();
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
    if (kind === "archive")
      await writeFile(join(directory, archiveName()), "corrupt");
    if (kind === "missing-archive") await rm(join(directory, archiveName()));
    if (kind === "oversized") await truncate(path, 64_000_001);
    fetcher.mockRejectedValueOnce(new Error("Offline"));
    await expect(
      new LocalMapDataSource(options).initialize(),
    ).rejects.toMatchObject({ code: "MAP_DATA_UNAVAILABLE" });
  });
  it("rebuilds a corrupt index without overwriting a pre-existing immutable archive", async () => {
    const { source, options, fetcher, directory } = await setup();
    download(fetcher);
    await source.initialize();
    await writeFile(join(directory, "map-catalog-v1.json"), "broken");
    download(fetcher);
    expect(
      (await new LocalMapDataSource(options).initialize()).status.stale,
    ).toBe(false);
    expect(await readFile(join(directory, archiveName()), "utf8")).toBe(
      "archive",
    );
    await writeFile(join(directory, archiveName()), "corrupt");
    download(fetcher);
    await expect(
      new LocalMapDataSource(options).initialize(),
    ).rejects.toMatchObject({ code: "MAP_DATA_UNAVAILABLE" });
    expect(await readFile(join(directory, archiveName()), "utf8")).toBe(
      "corrupt",
    );
  });
  it("concurrent independent writers publish only complete, matching archive/index snapshots", async () => {
    const { options, fetcher, directory } = await setup();
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
    expect((await readdir(directory)).sort()).toEqual(
      ["map-catalog-v1.json", archiveName()].sort(),
    );
  });
  it("does not swap in-memory last-good state when atomic index publication fails", async () => {
    const { source, fetcher, directory } = await setup();
    download(fetcher);
    const first = await source.initialize();
    await rm(join(directory, "map-catalog-v1.json"));
    await mkdir(join(directory, "map-catalog-v1.json"));
    fetcher.mockResolvedValueOnce(new Response(null, { status: 304 }));
    expect((await source.initialize(true)).status.stale).toBe(true);
    download(fetcher, 124, "next");
    const failed = await source.initialize(true);
    expect(failed.catalog).toBe(first.catalog);
    expect(failed.status).toMatchObject({
      buildNumber: 123,
      checkedAt: first.status.checkedAt,
      stale: true,
    });
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
