import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MapCatalog, mapSourceSchema } from "../lib/src/cartography/catalog.js";
import { readPreparedMapScene } from "../lib/src/cartography/prepared.js";
import { renderMap, renderPreparedMap } from "../lib/src/cartography/render.js";
import {
  LIGHT_YEAR_METRES,
  MapError,
  mapRequestSchema,
  type MapData,
  type MapRequest,
} from "../lib/src/cartography/types.js";
import { LocalMapStore, MAP_DATABASE_FILE } from "../src/map-store.js";

const directories: string[] = [];
const checkedAt = "2026-09-09T00:00:00.000Z";
const later = "2026-09-09T00:05:00.000Z";
const latest = "2026-09-09T00:10:00.000Z";
const metadata = {
  checkedAt,
  etag: '"build-42"',
  archiveSha256: "a".repeat(64),
};

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

function fixture(buildNumber = 42): MapData {
  return {
    schemaVersion: 1,
    buildNumber,
    releaseDate: "2026-09-01T00:00:00Z",
    fetchedAt: "2026-09-02T00:00:00Z",
    sourceUrl: `https://developers.eveonline.com/static-data/tranquility/eve-online-static-data-${buildNumber}-jsonl.zip`,
    regions: [
      { id: 100, name: "Region" },
      { id: 101, name: "100" },
    ],
    constellations: [
      { id: 200, name: "Constellation", regionId: 100 },
      { id: 201, name: "200", regionId: 101 },
    ],
    systems: ["Alpha", "Beta", "1", "Delta", "Epsilon"].map((name, index) => ({
      id: index + 1,
      name,
      regionId: index < 3 ? 100 : 101,
      constellationId: index < 3 ? 200 : 201,
      position: {
        x: index * 4 * LIGHT_YEAR_METRES,
        y: 1.234567891234567e18,
        z: (index % 2) * 3 * LIGHT_YEAR_METRES,
      },
      ...(index === 4
        ? {}
        : { position2D: { x: index * 4, y: (index % 2) * 3 } }),
      securityStatus: 0.4499999910593033,
    })),
    gates: [
      { id: 10, systemId: 1, destinationId: 2, destinationGateId: 11 },
      { id: 11, systemId: 2, destinationId: 1, destinationGateId: 10 },
      { id: 12, systemId: 1, destinationId: 2, destinationGateId: 13 },
      { id: 14, systemId: 2, destinationId: 3, destinationGateId: 15 },
      { id: 16, systemId: 4, destinationId: 1, destinationGateId: 17 },
      { id: 18, systemId: 3, destinationId: 5, destinationGateId: 19 },
      { id: 20, systemId: 3, destinationId: 5, destinationGateId: 21 },
    ],
  };
}
function request(overrides: Partial<MapRequest> = {}): MapRequest {
  return mapRequestSchema.parse({
    boundary: { kind: "systems", systems: [1, 2, 3] },
    pointsOfInterest: [],
    ...overrides,
  });
}
async function setup(data = fixture()) {
  const directory = await mkdtemp(join(tmpdir(), "eve-map-store-"));
  directories.push(directory);
  const catalog = new MapCatalog(data);
  const store = new LocalMapStore(directory);
  return {
    directory,
    path: join(directory, MAP_DATABASE_FILE),
    catalog,
    store,
  };
}
function sql(path: string, operation: (db: DatabaseSync) => void) {
  const db = new DatabaseSync(path);
  try {
    operation(db);
  } finally {
    db.close();
  }
}
function outcome(operation: () => unknown): unknown {
  try {
    return operation();
  } catch (error) {
    if (!(error instanceof MapError)) throw error;
    return { code: error.code, message: error.message, details: error.details };
  }
}
function parity(store: LocalMapStore, catalog: MapCatalog, input: MapRequest) {
  const expected = outcome(() => renderMap(catalog, input));
  const actual = outcome(() =>
    renderPreparedMap(store.prepare(input).scene, input),
  );
  expect(actual).toEqual(expected);
  return actual;
}

function captureReads() {
  const reads: { query: string; rows: Record<string, unknown>[] }[] = [];
  // eslint-disable-next-line @typescript-eslint/unbound-method -- Forwarded only via call() with an explicit DatabaseSync receiver.
  const prepare = DatabaseSync.prototype.prepare;
  vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (
    this: DatabaseSync,
    query,
  ) {
    const statement = prepare.call(this, query);
    const get = statement.get.bind(statement);
    const all = statement.all.bind(statement);
    vi.spyOn(statement, "get").mockImplementation((...parameters) => {
      const row = Reflect.apply(get, statement, parameters);
      reads.push({ query, rows: row ? [row] : [] });
      return row;
    });
    vi.spyOn(statement, "all").mockImplementation((...parameters) => {
      const rows = Reflect.apply(all, statement, parameters);
      reads.push({ query, rows });
      return rows;
    });
    return statement;
  });
  return reads;
}

describe("SQLite map preparation", () => {
  it.each<MapRequest["boundary"]>([
    { kind: "systems", systems: [3, " alpha ", 2, 1] },
    { kind: "region", region: " REGION " },
    { kind: "region", region: 100 },
    { kind: "region", region: "100" },
    { kind: "constellation", constellation: "constellation" },
    { kind: "constellation", constellation: 200 },
    { kind: "constellation", constellation: "200" },
    { kind: "neighborhood", center: " ALPHA ", jumps: 1 },
    { kind: "extent", minX: 0, maxX: 8, minZ: 0, maxZ: 3 },
    { kind: "extent", minX: 12, maxX: 16, minZ: 0, maxZ: 3 },
  ])("renders catalog-identical output for boundary %#", async (boundary) => {
    const { store, catalog } = await setup();
    const snapshot = store.publish(catalog, metadata);
    for (const layout of ["atlas", "geographic"] as const) {
      const input = request({ boundary, layout });
      parity(store, catalog, input);
      expect(store.prepare(input).snapshot).toEqual(snapshot);
    }
  });

  it("preserves parallel/directed gates, outgoing counts, incoming-only neighbors and distinct external pairs", async () => {
    const { store, catalog } = await setup();
    store.publish(catalog, metadata);
    const input = request({
      pointsOfInterest: [
        { system: "1", label: "Numeric name", kind: "waypoint" },
      ],
      routes: [{ systems: [1, 2, 1, 2, 3], label: "Repeated visits" }],
    });
    parity(store, catalog, input);
    const scene = readPreparedMapScene(store.prepare(input).scene);
    expect(scene.systems.map((item) => item.outgoingGateCount)).toEqual([
      2, 2, 2,
    ]);
    expect(scene.systems[0]?.securityStatus).toBe(0.4499999910593033);
    expect(scene.systems[0]?.position.y).toBe(1.234567891234567e18);
    expect(scene.internalPairs).toEqual([
      {
        from: 1,
        to: 2,
        directionMask: 3,
        forwardGateCount: 2,
        reverseGateCount: 1,
      },
      {
        from: 2,
        to: 3,
        directionMask: 1,
        forwardGateCount: 1,
        reverseGateCount: 0,
      },
    ]);
    expect(scene.boundaryConnections).toBe(2);
    const neighborhood = request({
      boundary: { kind: "neighborhood", center: 1, jumps: 1 },
    });
    parity(store, catalog, neighborhood);
    expect(
      readPreparedMapScene(store.prepare(neighborhood).scene).systems.map(
        (item) => item.id,
      ),
    ).toEqual([1, 2, 4]);
    const reverse = request({ routes: [{ systems: [3, 2] }] });
    expect(parity(store, catalog, reverse)).toMatchObject({
      code: "INVALID_ROUTE_ADJACENCY",
    });
    expect(
      parity(store, catalog, request({ routes: [{ systems: [1, 1] }] })),
    ).toMatchObject({ code: "INVALID_ROUTE_ADJACENCY" });
  });

  it("resolves names globally with exact counts and ten ascending candidates, never coerces numeric strings", async () => {
    const data = fixture();
    for (let index = 12; index >= 0; index--) {
      data.systems.push({
        id: 1000 + index,
        name: " ALPHA ",
        regionId: 101,
        constellationId: 201,
        position: { x: 1e20, y: 0, z: 1e20 },
        securityStatus: 0,
      });
    }
    const { store, catalog } = await setup(data);
    store.publish(catalog, metadata);
    const result = parity(
      store,
      catalog,
      request({
        pointsOfInterest: [
          {
            system: " alpha ",
            label: "Ambiguous outside boundary",
            kind: "activity",
          },
        ],
      }),
    );
    expect(result).toMatchObject({
      code: "MAP_REFERENCE_AMBIGUOUS",
      details: {
        candidateCount: 14,
        candidates: [
          { id: 1, name: "Alpha" },
          ...Array.from({ length: 9 }, (_, index) => ({
            id: 1000 + index,
            name: "ALPHA",
          })),
        ],
      },
    });
    for (const systems of [[1], ["1"], ["01"], ["Alph"], [9999], ["missing"]])
      parity(
        store,
        catalog,
        request({ boundary: { kind: "systems", systems } }),
      );
    expect(
      readPreparedMapScene(
        store.prepare(
          request({ boundary: { kind: "systems", systems: ["1"] } }),
        ).scene,
      ).systems.map((item) => item.id),
    ).toEqual([3]);
  });

  it("uses JavaScript Unicode lowercase rather than SQLite ASCII NOCASE", async () => {
    const data = fixture();
    const name = "\u0130".repeat(100);
    data.systems = data.systems.map((system) =>
      system.id === 1 ? { ...system, name } : system,
    );
    const { store, catalog } = await setup(data);
    store.publish(catalog, metadata);
    parity(
      store,
      catalog,
      request({ boundary: { kind: "systems", systems: [name] } }),
    );
  });

  it.each(["oversized", "nul", "normalized-oversized", "normalized-nul"])(
    "rejects %s matched and selected entity text before native retrieval, not as unknown names",
    async (damage) => {
      const { store, catalog, path } = await setup();
      store.publish(catalog, metadata);
      sql(path, (db) => {
        if (damage.startsWith("normalized"))
          db.prepare(
            "UPDATE entities SET normalized_name = ? WHERE category = 'system' AND id = 1",
          ).run(damage.endsWith("nul") ? "alpha\0suffix" : "a".repeat(100_000));
        else
          db.prepare(
            "UPDATE entities SET name = ? WHERE category = 'system' AND id = 1",
          ).run(damage === "nul" ? "Alpha\0suffix" : "A".repeat(100_000));
      });
      const reads = captureReads();
      const reference = damage.startsWith("normalized") ? 1 : "Alpha";
      expect(
        outcome(() =>
          store.prepare(
            request({ boundary: { kind: "systems", systems: [reference] } }),
          ),
        ),
      ).toMatchObject({ code: "MAP_DATA_INVALID" });
      expect(
        outcome(() =>
          store.prepare(request({ boundary: { kind: "region", region: 100 } })),
        ),
      ).toMatchObject({ code: "MAP_DATA_INVALID" });
      for (const value of reads.flatMap((read) =>
        read.rows.flatMap((row) => Object.values(row)),
      )) {
        if (typeof value === "string") {
          expect(Buffer.byteLength(value)).toBeLessThanOrEqual(8192);
          expect(value).not.toContain("\0");
        }
      }
      expect(
        reads.some(
          (read) =>
            read.query.startsWith("WITH queries") &&
            read.rows.some((row) => row.fact === null),
        ),
      ).toBe(true);
    },
  );

  it("rejects corrupt matching names beyond the first ten candidates instead of returning mere ambiguity", async () => {
    const data = fixture();
    for (let id = 10; id < 25; id++)
      data.systems.push({
        id,
        name: "Alpha",
        regionId: 101,
        constellationId: 201,
        position: { x: 0, y: 0, z: 0 },
        securityStatus: 0,
      });
    const { store, catalog, path } = await setup(data);
    store.publish(catalog, metadata);
    sql(path, (db) =>
      db
        .prepare(
          "UPDATE entities SET name = ? WHERE category = 'system' AND id = 24",
        )
        .run("Alpha\0suffix"),
    );
    expect(
      outcome(() =>
        store.prepare(
          request({ boundary: { kind: "systems", systems: ["Alpha"] } }),
        ),
      ),
    ).toMatchObject({ code: "MAP_DATA_INVALID" });
  });

  it.each(["region", "constellation"])(
    "guards %s names on selected-only paths",
    async (category) => {
      const { store, catalog, path } = await setup();
      store.publish(catalog, metadata);
      sql(path, (db) =>
        db
          .prepare(
            "UPDATE entities SET name = name || char(0) || 'suffix' WHERE category = ?",
          )
          .run(category),
      );
      const reads = captureReads();
      expect(outcome(() => store.prepare(request()))).toMatchObject({
        code: "MAP_DATA_INVALID",
      });
      const selected = reads.find((read) => read.query.includes("SELECT s.*"));
      expect(
        selected?.rows.some((row) => row[`${category}_name`] === null),
      ).toBe(true);
    },
  );

  it.each([
    "DELETE FROM connections WHERE from_id = 1 AND to_id = 4",
    "DELETE FROM connections WHERE from_id = 3 AND to_id = 5",
    "UPDATE connections SET forward_count = 1 WHERE from_id = 1 AND to_id = 2",
    "UPDATE connections SET reverse_count = 0 WHERE from_id = 1 AND to_id = 2",
  ])(
    "rejects incomplete incoming/outgoing degrees even with other boundary connections: %s",
    async (damage) => {
      const { store, catalog, path } = await setup();
      store.publish(catalog, metadata);
      sql(path, (db) => {
        db.exec(damage);
      });
      expect(() => store.prepare(request())).toThrow(
        "connection degrees do not match",
      );
    },
  );

  it("does not silently omit a deleted incoming-only neighbor", async () => {
    const { store, catalog, path } = await setup();
    store.publish(catalog, metadata);
    const input = request({
      boundary: { kind: "neighborhood", center: 1, jumps: 1 },
    });
    sql(path, (db) => {
      db.exec("DELETE FROM connections WHERE from_id = 1 AND to_id = 4");
    });
    expect(() => store.prepare(input)).toThrow(
      "connection degrees do not match",
    );
  });

  it("matches global region/constellation ambiguity, missing references and deferred out-of-boundary errors", async () => {
    const data = fixture();
    data.regions.push({ id: 102, name: "REGION" });
    data.constellations.push({ id: 202, name: "CONSTELLATION", regionId: 102 });
    const { store, catalog } = await setup(data);
    store.publish(catalog, metadata);
    for (const boundary of [
      { kind: "region", region: "Region" },
      { kind: "constellation", constellation: "Constellation" },
      { kind: "region", region: "missing" },
      { kind: "constellation", constellation: 999 },
      { kind: "region", region: 102 },
      { kind: "extent", minX: -10, maxX: -1, minZ: -10, maxZ: -1 },
    ] satisfies MapRequest["boundary"][])
      parity(store, catalog, request({ boundary }));
    for (const system of [4, "Delta", "missing"])
      parity(
        store,
        catalog,
        request({
          pointsOfInterest: [{ system, label: "Outside", kind: "warning" }],
        }),
      );
    parity(
      store,
      catalog,
      request({ routes: [{ systems: [1, 4, "missing"] }] }),
    );
  });

  it.each([250, 251, 300])(
    "counts the complete %i-system boundary without trimming or fetching oversized facts",
    async (count) => {
      const data = fixture();
      data.systems = Array.from({ length: count }, (_, index) => ({
        id: index + 1,
        name: `System ${index + 1}`,
        regionId: 100,
        constellationId: 200,
        position: { x: index * LIGHT_YEAR_METRES, y: 0, z: 0 },
        securityStatus: 0,
      }));
      data.gates = data.systems.slice(1).map((system, index) => ({
        id: 10000 + index * 2,
        systemId: system.id,
        destinationId: 1,
        destinationGateId: 10001 + index * 2,
      }));
      const { store, catalog } = await setup(data);
      store.publish(catalog, metadata);
      for (const boundary of [
        { kind: "region", region: 100 },
        { kind: "constellation", constellation: 200 },
        { kind: "neighborhood", center: 1, jumps: 1 },
        { kind: "extent", minX: -1, maxX: count, minZ: -1, maxZ: 1 },
      ] satisfies MapRequest["boundary"][]) {
        const input = request({ boundary, layout: "geographic" });
        const spy = vi.spyOn(DatabaseSync.prototype, "prepare");
        const actual = outcome(() => store.prepare(input));
        if (count > 250) {
          expect(actual).toMatchObject({
            code: "MAP_TOO_LARGE",
            details: { systemCount: count },
          });
          expect(
            spy.mock.calls.some(
              ([query]) =>
                query.includes("touching AS") || query.includes("SELECT s.*"),
            ),
          ).toBe(false);
        } else {
          expect(
            readPreparedMapScene(store.prepare(input).scene).systems,
          ).toHaveLength(count);
        }
        spy.mockRestore();
        if (count > 250) parity(store, catalog, input);
      }
    },
  );

  it("uses selected-driven indexed reads and never loads the compatibility catalog", async () => {
    const { store, catalog, path } = await setup();
    store.publish(catalog, metadata);
    sql(path, (db) => db.prepare("UPDATE catalog SET data = 'corrupt'").run());
    const load = vi.spyOn(store, "loadCatalog").mockImplementation(() => {
      throw new Error("Catalog must not load");
    });
    for (const boundary of [
      { kind: "systems", systems: [1, "Beta", "1"] },
      { kind: "neighborhood", center: 1, jumps: 1 },
      { kind: "region", region: 100 },
      { kind: "constellation", constellation: 200 },
      { kind: "extent", minX: 0, maxX: 8, minZ: 0, maxZ: 3 },
    ] satisfies MapRequest["boundary"][]) {
      const spy = vi.spyOn(DatabaseSync.prototype, "prepare");
      parity(store, catalog, request({ boundary }));
      const queries = spy.mock.calls.map(([query]) => query);
      spy.mockRestore();
      expect(queries.length).toBeLessThanOrEqual(10);
      expect(queries.some((query) => /\bFROM catalog\b/.test(query))).toBe(
        false,
      );
      const plans: string[] = [];
      sql(path, (db) => {
        for (const query of queries.filter(
          (query) =>
            /^(WITH|SELECT)/.test(query) && !query.includes("sqlite_schema"),
        )) {
          plans.push(
            ...db
              .prepare(`EXPLAIN QUERY PLAN ${query}`)
              .all(
                ...Array.from(
                  { length: query.match(/\?/g)?.length ?? 0 },
                  () => null,
                ),
              )
              .map((row) => String(row.detail)),
          );
        }
      });
      expect(plans.join("\n")).toMatch(
        /SEARCH e USING (?:COVERING )?INDEX entities_name/,
      );
      expect(plans.join("\n")).toMatch(/SEARCH s USING INTEGER PRIMARY KEY/);
      expect(plans.join("\n")).toMatch(/SEARCH c USING PRIMARY KEY \(from_id=/);
      expect(plans.join("\n")).toMatch(
        /SEARCH c USING INDEX connections_to \(to_id=/,
      );
      expect(
        plans.some((plan) =>
          /SCAN (?:e|c|systems|entities|connections)\b/.test(plan),
        ),
      ).toBe(false);
      if (boundary.kind === "region")
        expect(plans.join("\n")).toContain("systems_region (region_id=?");
      if (boundary.kind === "constellation")
        expect(plans.join("\n")).toContain(
          "systems_constellation (constellation_id=?",
        );
      if (boundary.kind === "extent")
        expect(plans.join("\n")).toContain("systems_extent (x_ly>?");
    }
    expect(load).not.toHaveBeenCalled();
    load.mockRestore();
    expect(() => store.loadCatalog()).toThrow(
      "corrupt local map compatibility catalog",
    );
  });
});

describe("SQLite map snapshots", () => {
  it("does not create files for absent reads, preparation, touches or compatibility loads", async () => {
    const { directory, catalog, store } = await setup();
    const nested = new LocalMapStore(join(directory, "absent"));
    expect(store.read()).toBeUndefined();
    expect(nested.read()).toBeUndefined();
    expect(() => nested.prepare(request())).toThrow("No local map snapshot");
    expect(() => nested.loadCatalog()).toThrow("No local map snapshot");
    expect(() =>
      nested.touch(
        { source: mapSourceSchema.parse(catalog.data), ...metadata },
        later,
        null,
      ),
    ).toThrow("No local map snapshot");
    expect(await readdir(directory)).toEqual([]);
    const snapshot = nested.publish(catalog, metadata);
    expect(nested.read()).toEqual(snapshot);
  });

  it("opens and closes per operation, uses WAL/FULL/5000 and actual readonly request connections", async () => {
    const { store, catalog, path } = await setup();
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Forwarded only via call() with an explicit DatabaseSync receiver.
    const prepare = DatabaseSync.prototype.prepare;
    const policies: unknown[] = [];
    const spy = vi
      .spyOn(DatabaseSync.prototype, "prepare")
      .mockImplementation(function (this: DatabaseSync, query) {
        if (query.startsWith("INSERT INTO active")) {
          policies.push([
            prepare.call(this, "PRAGMA journal_mode").get()?.journal_mode,
            prepare.call(this, "PRAGMA synchronous").get()?.synchronous,
            prepare.call(this, "PRAGMA busy_timeout").get()?.timeout,
          ]);
        }
        if (query.startsWith("WITH queries")) {
          this.exec("PRAGMA query_only = OFF");
          expect(() => prepare.call(this, "DELETE FROM active").run()).toThrow(
            /readonly/,
          );
          this.exec("PRAGMA query_only = ON");
        }
        return prepare.call(this, query);
      });
    const close = vi.spyOn(DatabaseSync.prototype, "close");
    store.publish(catalog, metadata);
    store.read();
    store.prepare(request());
    store.loadCatalog();
    expect(close).toHaveBeenCalledTimes(4);
    expect(policies).toEqual([["wal", 2, 5000]]);
    spy.mockRestore();
    sql(path, (db) => {
      expect(db.prepare("PRAGMA journal_mode").get()?.journal_mode).toBe("wal");
    });
  });

  it("survives restart, does not retain catalogs, and revalidates mutable catalog data before publishing", async () => {
    const { store, catalog, directory } = await setup();
    catalog.systems.clear();
    const snapshot = store.publish(catalog, metadata);
    catalog.data.systems = [];
    expect(() => store.publish(catalog, metadata)).toThrow("Invalid map data");
    const restarted = new LocalMapStore(directory);
    expect(restarted.read()).toEqual(snapshot);
    expect(restarted.loadCatalog().catalog.data).toEqual(
      new MapCatalog(fixture()).data,
    );
    snapshot.source.buildNumber = 999;
    expect(restarted.read()?.source.buildNumber).toBe(42);
    parity(restarted, new MapCatalog(fixture()), request());
  });

  it("fences stale publishers and touches without mixing ETags or regressing checkedAt", async () => {
    const { store, catalog, directory } = await setup();
    const other = new LocalMapStore(directory);
    const first = store.publish(catalog, metadata);
    const checked = other.touch(first, later, '"later"');
    expect(store.touch(first, checkedAt, '"old"')).toEqual(checked);
    expect(store.touch(first, later, '"equal-time"')).toEqual(checked);
    expect(store.publish(catalog, metadata)).toEqual(checked);
    const refreshed = other.publish(
      new MapCatalog({ ...fixture(), fetchedAt: later }),
      {
        ...metadata,
        checkedAt: latest,
        etag: '"refreshed"',
      },
    );
    expect(refreshed).toEqual(checked);
    expect(refreshed.source.fetchedAt).toBe(first.source.fetchedAt);
    expect(
      store.touch(
        { ...refreshed, archiveSha256: "f".repeat(64) },
        "2026-10-01T00:00:00Z",
        '"wrong-digest"',
      ),
    ).toEqual(refreshed);
    const newer = other.publish(new MapCatalog(fixture(43)), {
      checkedAt: latest,
      etag: '"new-build"',
      archiveSha256: "b".repeat(64),
    });
    expect(
      store.publish(catalog, {
        ...metadata,
        checkedAt: "2026-10-01T00:00:00Z",
        etag: '"stale"',
      }),
    ).toEqual(newer);
    expect(store.touch(first, "2026-10-01T00:00:00Z", '"stale-304"')).toEqual(
      newer,
    );
    expect(store.read()).toEqual(newer);
    expect(store.loadCatalog().catalog.data.buildNumber).toBe(43);
  });

  it("keeps an intervening same-build ETag when a stale 304 or download completes later", async () => {
    const { store, catalog, directory } = await setup();
    const first = store.publish(catalog, metadata);
    const other = new LocalMapStore(directory);
    const checked = other.touch(first, later, '"E2"');
    const writes = vi.spyOn(DatabaseSync.prototype, "prepare");
    expect(store.touch(first, latest, first.etag)).toEqual(checked);
    expect(
      store.publish(new MapCatalog({ ...fixture(), fetchedAt: latest }), {
        ...metadata,
        checkedAt: latest,
        etag: '"E1-from-overlapping-manifest"',
      }),
    ).toEqual(checked);
    expect(
      writes.mock.calls.some(([query]) =>
        /^(UPDATE|INSERT|DELETE)/.test(query),
      ),
    ).toBe(false);
    writes.mockRestore();
    expect(store.read()).toEqual(checked);
    expect(store.touch(checked, latest, '"E3"')).toEqual({
      ...checked,
      checkedAt: latest,
      etag: '"E3"',
    });
  });

  it.each(["checkedAt", "etag", "fetchedAt"])(
    "independently fences the observed %s during touch",
    async (field) => {
      const { store, catalog } = await setup();
      const first = store.publish(catalog, metadata);
      const expected = structuredClone(first);
      if (field === "checkedAt") expected.checkedAt = later;
      if (field === "etag") expected.etag = '"different"';
      if (field === "fetchedAt") expected.source.fetchedAt = later;
      expect(store.touch(expected, latest, '"late"')).toEqual(first);
      expect(store.read()).toEqual(first);
    },
  );

  it.each(["release", "url", "archive", "content"])(
    "rejects same-build %s conflicts without replacing any rows",
    async (kind) => {
      const { store, catalog } = await setup();
      const first = store.publish(catalog, metadata);
      const data = fixture();
      if (kind === "release") data.releaseDate = later;
      if (kind === "url") data.sourceUrl = "https://example.invalid/different";
      if (kind === "content")
        data.systems = data.systems.map((system) => ({
          ...system,
          securityStatus: 0.1,
        }));
      expect(() =>
        store.publish(new MapCatalog(data), {
          ...metadata,
          checkedAt: later,
          archiveSha256:
            kind === "archive" ? "b".repeat(64) : metadata.archiveSha256,
        }),
      ).toThrow("Conflicting identity or digest");
      expect(store.read()).toEqual(first);
      expect(store.loadCatalog().catalog.data).toEqual(catalog.data);
    },
  );

  it("reads metadata, resolution, systems and pairs from one WAL snapshot during another publication", async () => {
    const { store, catalog, directory } = await setup();
    const first = store.publish(catalog, metadata);
    const next = fixture(43);
    next.systems = next.systems.map((system) => ({
      ...system,
      name: `New ${system.name}`,
    }));
    next.gates = [];
    const writer = new LocalMapStore(directory);
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Forwarded only via call() with an explicit DatabaseSync receiver.
    const prepare = DatabaseSync.prototype.prepare;
    let published = false;
    const spy = vi
      .spyOn(DatabaseSync.prototype, "prepare")
      .mockImplementation(function (this: DatabaseSync, query) {
        if (!published && query.startsWith("WITH queries")) {
          published = true;
          writer.publish(new MapCatalog(next), {
            ...metadata,
            checkedAt: later,
            archiveSha256: "b".repeat(64),
          });
        }
        return prepare.call(this, query);
      });
    const result = store.prepare(request());
    spy.mockRestore();
    expect(published).toBe(true);
    expect(result.snapshot).toEqual(first);
    expect(renderPreparedMap(result.scene)).toEqual(
      renderMap(catalog, request()),
    );
    expect(store.read()?.source.buildNumber).toBe(43);
    parity(store, new MapCatalog(next), request());
  });

  it("rolls back a failure after replacing projection rows and leaves the old build usable", async () => {
    const { store, catalog } = await setup();
    const first = store.publish(catalog, metadata);
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Forwarded only via call() with an explicit DatabaseSync receiver.
    const prepare = DatabaseSync.prototype.prepare;
    const spy = vi
      .spyOn(DatabaseSync.prototype, "prepare")
      .mockImplementation(function (this: DatabaseSync, query) {
        const statement = prepare.call(this, query);
        if (query.startsWith("INSERT INTO active"))
          vi.spyOn(statement, "run").mockImplementation(() => {
            throw new Error("Injected publication failure");
          });
        return statement;
      });
    expect(() => store.publish(new MapCatalog(fixture(43)), metadata)).toThrow(
      "Injected publication failure",
    );
    spy.mockRestore();
    expect(store.read()).toEqual(first);
    expect(store.loadCatalog().catalog.data).toEqual(catalog.data);
    parity(store, catalog, request());
    expect(
      store.publish(new MapCatalog(fixture(43)), metadata).source.buildNumber,
    ).toBe(43);
  });

  it("does not expose partial rows after a failed first publication and can retry the valid empty schema", async () => {
    const { store, catalog } = await setup();
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Forwarded only via call() with an explicit DatabaseSync receiver.
    const prepare = DatabaseSync.prototype.prepare;
    const spy = vi
      .spyOn(DatabaseSync.prototype, "prepare")
      .mockImplementation(function (this: DatabaseSync, query) {
        const statement = prepare.call(this, query);
        if (query.startsWith("INSERT INTO catalog"))
          vi.spyOn(statement, "run").mockImplementation(() => {
            throw new Error("Injected first publication failure");
          });
        return statement;
      });
    expect(() => store.publish(catalog, metadata)).toThrow(
      "Injected first publication failure",
    );
    spy.mockRestore();
    expect(store.read()).toBeUndefined();
    expect(() => store.prepare(request())).toThrow("No local map snapshot");
    expect(() => store.loadCatalog()).toThrow("No local map snapshot");
    store.publish(catalog, metadata);
    parity(store, catalog, request());
  });

  it("respects abort before opening and after selected reads, without mutating caller input", async () => {
    const { store, catalog, directory } = await setup();
    const controller = new AbortController();
    const reason = new Error("Caller cancelled");
    controller.abort(reason);
    expect(() => store.prepare(request(), controller.signal)).toThrow(reason);
    expect(await readdir(directory)).toEqual([]);
    store.publish(catalog, metadata);
    const input: MapRequest = {
      ...request(),
      boundary: { kind: "systems", systems: [" Alpha ", 2, 3] },
    };
    const original = structuredClone(input);
    Object.freeze(input.boundary);
    Object.freeze(input);
    store.prepare(input);
    expect(input).toEqual(original);
    const during = new AbortController();
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Forwarded only via call() with an explicit DatabaseSync receiver.
    const prepare = DatabaseSync.prototype.prepare;
    const spy = vi
      .spyOn(DatabaseSync.prototype, "prepare")
      .mockImplementation(function (this: DatabaseSync, query) {
        if (query.includes("touching AS")) during.abort(reason);
        return prepare.call(this, query);
      });
    const close = vi.spyOn(DatabaseSync.prototype, "close");
    expect(() => store.prepare(input, during.signal)).toThrow(reason);
    expect(close).toHaveBeenCalledTimes(1);
    spy.mockRestore();
    parity(store, catalog, input);
  });

  it.each([
    "PRAGMA user_version = 2",
    "PRAGMA user_version = 0",
    "PRAGMA application_id = 0",
    "DROP INDEX systems_region",
    "CREATE TABLE unexpected (id INTEGER)",
    "CREATE TRIGGER unexpected AFTER UPDATE ON active BEGIN DELETE FROM systems; END",
  ])(
    "fails closed without destructive recovery for schema damage: %s",
    async (damage) => {
      const { store, catalog, path } = await setup();
      const first = store.publish(catalog, metadata);
      sql(path, (db) => {
        db.exec(damage);
      });
      const before = await readFile(path);
      for (const action of [
        () => store.read(),
        () => store.prepare(request()),
        () => store.loadCatalog(),
        () => store.publish(new MapCatalog(fixture(43)), metadata),
        () => store.touch(first, later, null),
      ])
        expect(action).toThrow(
          "Unsupported or corrupt local map database schema",
        );
      expect(await readFile(path)).toEqual(before);
    },
  );

  it.each(["", "not a SQLite database"])(
    "does not replace pre-existing empty or corrupt database files %#",
    async (text) => {
      const { store, catalog, path } = await setup();
      await writeFile(path, text);
      expect(() => store.read()).toThrow();
      expect(() => store.publish(catalog, metadata)).toThrow();
      expect(await readFile(path, "utf8")).toBe(text);
    },
  );

  it.each(["sql-nul", "sql-oversized", "name-nul", "tbl_name-nul", "type-nul"])(
    "rejects %s schema text rather than accepting a NUL-truncated prefix",
    async (damage) => {
      const { store, catalog, path } = await setup();
      store.publish(catalog, metadata);
      sql(path, (db) => {
        // Newer Node enables defensive mode; only this corruption fixture disables it.
        const enableDefensive: unknown = Reflect.get(db, "enableDefensive");
        if (typeof enableDefensive === "function")
          Reflect.apply(enableDefensive, db, [false]);
        db.exec("PRAGMA writable_schema = ON");
        if (damage === "sql-oversized")
          db.prepare(
            "UPDATE sqlite_schema SET sql = sql || ? WHERE name = 'active'",
          ).run(` /* ${"x".repeat(100_000)} */`);
        else {
          const column = damage.slice(0, -4);
          db.exec(
            `UPDATE sqlite_schema SET ${column} = ${column} || char(0) || 'suffix' WHERE name = 'active'`,
          );
        }
        db.exec("PRAGMA writable_schema = OFF");
      });
      const before = await readFile(path);
      const reads = captureReads();
      expect(() => store.read()).toThrow();
      expect(() =>
        store.publish(new MapCatalog(fixture(43)), metadata),
      ).toThrow();
      for (const row of reads
        .filter((read) => read.query.includes("FROM sqlite_schema"))
        .flatMap((read) => read.rows)) {
        if (typeof row.sql === "string") {
          expect(Buffer.byteLength(row.sql)).toBeLessThanOrEqual(8192);
          expect(row.sql).not.toContain("\0");
        }
      }
      expect(await readFile(path)).toEqual(before);
    },
  );

  it("limits schema result materialization to the known object count plus one", async () => {
    const { store, catalog, path } = await setup();
    store.publish(catalog, metadata);
    let expectedCount = 0;
    sql(path, (db) => {
      expectedCount = Number(
        db
          .prepare(
            "SELECT count(*) AS count FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*'",
          )
          .get()?.count,
      );
      for (let index = 0; index < 25; index++)
        db.exec(`CREATE TABLE extra_${index} (id INTEGER)`);
    });
    const reads = captureReads();
    expect(() => store.read()).toThrow(
      "Unsupported or corrupt local map database schema",
    );
    const schema = reads.find((read) =>
      read.query.includes("FROM sqlite_schema"),
    );
    expect(schema?.rows).toHaveLength(expectedCount + 1);
  });

  it.each([
    "UPDATE active SET snapshot = 'not-json'",
    "UPDATE active SET snapshot = '{}'",
    "UPDATE active SET catalog_sha256 = 'bad'",
    "UPDATE active SET content_sha256 = 'bad'",
    "DELETE FROM active",
  ])("rejects corrupt active metadata: %s", async (damage) => {
    const { store, catalog, path } = await setup();
    store.publish(catalog, metadata);
    sql(path, (db) => {
      db.exec(damage);
    });
    expect(() => store.read()).toThrow();
    expect(() => store.prepare(request())).toThrow();
    expect(() =>
      store.publish(new MapCatalog(fixture(43)), metadata),
    ).toThrow();
  });

  it.each([
    ["snapshot", "nul"],
    ["snapshot", "oversized"],
    ["catalog_sha256", "nul"],
    ["catalog_sha256", "oversized"],
    ["content_sha256", "nul"],
    ["content_sha256", "oversized"],
  ])(
    "guards active %s %s bytes before native retrieval",
    async (column, damage) => {
      const { store, catalog, path } = await setup();
      store.publish(catalog, metadata);
      sql(path, (db) => {
        db.exec("PRAGMA ignore_check_constraints = ON");
        if (damage === "nul")
          db.exec(
            `UPDATE active SET ${column} = ${column} || char(0) || 'suffix'`,
          );
        else
          db.prepare(`UPDATE active SET ${column} = ?`).run(
            "a".repeat(100_000),
          );
      });
      const reads = captureReads();
      expect(outcome(() => store.read())).toMatchObject({
        code: "MAP_DATA_INVALID",
      });
      expect(
        reads.find((read) => read.query.includes("FROM active WHERE id = 1"))
          ?.rows[0]?.[column],
      ).toBeNull();
      expect(() => store.loadCatalog()).toThrow();
      expect(() => store.prepare(request())).toThrow();
    },
  );

  it.each([
    ["$.checkedAt", `2026-09-09T00:00:00.${"1".repeat(1000)}Z`],
    ["$.source.releaseDate", `2026-09-09T00:00:00.${"1".repeat(1000)}Z`],
    ["$.source.fetchedAt", `2026-09-09T00:00:00.${"1".repeat(1000)}Z`],
    ["$.source.sourceUrl", `https://example.invalid/${"x".repeat(3000)}`],
    ["$.source.sourceUrl", "https://example.invalid/\0suffix"],
    ["$.etag", '"tag"\0suffix'],
  ])(
    "rejects bounded but invalid decoded metadata at %s %#",
    async (key, value) => {
      const { store, catalog, path } = await setup();
      store.publish(catalog, metadata);
      sql(path, (db) =>
        db
          .prepare("UPDATE active SET snapshot = json_set(snapshot, ?, ?)")
          .run(key, value),
      );
      expect(outcome(() => store.read())).toMatchObject({
        code: "MAP_DATA_INVALID",
      });
    },
  );

  it.each([
    "UPDATE systems SET security_status = 1e999 WHERE id = 1",
    "UPDATE systems SET outgoing_gate_count = 0 WHERE id = 1",
    "UPDATE systems SET incoming_gate_count = 500001 WHERE id = 1",
    "UPDATE systems SET region_id = 101 WHERE id = 1",
    "DELETE FROM entities WHERE category = 'constellation' AND id = 200",
    "UPDATE entities SET name = 'Different' WHERE category = 'system' AND id = 1",
  ])(
    "validates selected facts rather than trusting corrupt projection rows: %s",
    async (damage) => {
      const { store, catalog, path } = await setup();
      store.publish(catalog, metadata);
      sql(path, (db) => {
        db.exec(damage);
      });
      expect(() =>
        store.prepare(
          request({ boundary: { kind: "systems", systems: ["Alpha", 2, 3] } }),
        ),
      ).toThrow();
    },
  );

  it("bounds and checksums compatibility JSON, validates catalog identity even with a matching checksum", async () => {
    const { store, catalog, path } = await setup();
    store.publish(catalog, metadata);
    const text = JSON.stringify(fixture(99));
    const digest = createHash("sha256").update(text).digest("hex");
    sql(path, (db) => {
      db.prepare("UPDATE catalog SET data = ?").run(text);
      db.prepare("UPDATE active SET catalog_sha256 = ?").run(digest);
    });
    expect(() => store.loadCatalog()).toThrow(
      "does not match the active snapshot",
    );
    sql(path, (db) => {
      db.exec("PRAGMA ignore_check_constraints = ON");
      db.exec("UPDATE catalog SET data = CAST(zeroblob(64000001) AS TEXT)");
    });
    const reads = captureReads();
    expect(() => store.loadCatalog()).toThrow("oversized or corrupt");
    expect(
      reads.find((read) => read.query.includes("FROM catalog WHERE id = 1"))
        ?.rows[0]?.data,
    ).toBeNull();
    parity(store, catalog, request());
  });

  it("rejects NUL-suffixed catalog text before the driver can truncate it to a checksum-matching prefix", async () => {
    const { store, catalog, path } = await setup();
    store.publish(catalog, metadata);
    sql(path, (db) => {
      db.exec("UPDATE catalog SET data = data || char(0) || 'suffix'");
    });
    const reads = captureReads();
    expect(() => store.loadCatalog()).toThrow("oversized or corrupt");
    expect(
      reads.find((read) => read.query.includes("FROM catalog WHERE id = 1"))
        ?.rows[0]?.data,
    ).toBeNull();
    parity(store, catalog, request());
  });

  it.each([
    { checkedAt: "invalid" },
    { etag: "bad\nvalue" },
    { etag: "bad\0value" },
    { etag: "x".repeat(1025) },
    { archiveSha256: "BAD" },
    { archiveSha256: `${"a".repeat(64)}\n` },
    { checkedAt: `2026-09-09T00:00:00.${"1".repeat(1000)}Z` },
  ])(
    "rejects malformed publication/check metadata before disk writes %#",
    async (change) => {
      const { store, catalog, directory } = await setup();
      expect(() => store.publish(catalog, { ...metadata, ...change })).toThrow(
        "Invalid local map publication metadata",
      );
      expect(await readdir(directory)).toEqual([]);
      const first = store.publish(catalog, metadata);
      expect(() => store.touch(first, "invalid", null)).toThrow(
        "Invalid local map check metadata",
      );
      expect(store.read()).toEqual(first);
    },
  );

  it.each([
    { releaseDate: `2026-09-09T00:00:00.${"1".repeat(1000)}Z` },
    { fetchedAt: `2026-09-09T00:00:00.${"1".repeat(1000)}Z` },
    { sourceUrl: `https://example.invalid/${"x".repeat(3000)}` },
  ])("bounds source metadata before publication %#", async (change) => {
    const { store, directory } = await setup();
    expect(() =>
      store.publish(new MapCatalog({ ...fixture(), ...change }), metadata),
    ).toThrow("Invalid local map source metadata");
    expect(await readdir(directory)).toEqual([]);
  });

  it("rejects malformed requests before any SQLite query", async () => {
    const { store } = await setup();
    const spy = vi.spyOn(DatabaseSync.prototype, "prepare");
    expect(() =>
      store.prepare({
        ...request(),
        boundary: { kind: "systems", systems: [] },
      }),
    ).toThrow("Invalid map request");
    expect(spy).not.toHaveBeenCalled();
  });
});
