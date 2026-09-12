import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SkillCatalog } from "../src/skill-data.js";
import {
  SkillImport,
  SkillStore,
  skillBuildSourceUrl,
} from "../src/skill-store.js";
import { buildSkillGraph } from "../src/skill-graph.js";
import { SkillPlanner } from "../src/skill-plan.js";
import { EsiClient, type EsiResponse } from "../src/esi-client.js";
import { OperationCatalog } from "../src/openapi.js";
import { StaticTokenProvider } from "../src/auth.js";
import { fixtureDocument } from "./fixtures.js";
import { skill, skillFixture } from "./skill-fixtures.js";

const directories: string[] = [];
const releases: (() => void)[] = [];
const nativeExec = Reflect.get(DatabaseSync.prototype, "exec");
const nativePrepare = Reflect.get(DatabaseSync.prototype, "prepare");
afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
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
  const directory = await mkdtemp(join(tmpdir(), "eve-skill-store-"));
  directories.push(directory);
  const store = new SkillStore(directory);
  return {
    directory,
    path: join(directory, "skills-v1.sqlite"),
    store,
    acquire: () => {
      const snapshot = store.acquire();
      releases.push(snapshot.release);
      return snapshot;
    },
  };
}
function candidate(build = 123, checkedAt = "2026-09-07T00:00:00Z") {
  return {
    catalog: new SkillCatalog({
      ...skillFixture(),
      buildNumber: build,
      sourceUrl: skillBuildSourceUrl(build),
    }),
    checkedAt,
    etag: `"build-${build}"`,
  };
}
function edit(path: string, sql: string) {
  const db = new DatabaseSync(path);
  try {
    db.exec(sql);
  } finally {
    db.close();
  }
}
const v1Table = `CREATE TABLE skill_catalog (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  generation INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  build_number INTEGER NOT NULL,
  release_date TEXT NOT NULL,
  source_url TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  checked_at TEXT NOT NULL,
  etag TEXT,
  catalog_json TEXT NOT NULL
) STRICT`;
function legacy(path: string, empty = false) {
  const db = new DatabaseSync(path);
  try {
    db.exec(
      `${v1Table}; PRAGMA application_id=1163285323; PRAGMA user_version=1`,
    );
    if (!empty) {
      const c = candidate();
      const data = c.catalog.data;
      const json = JSON.stringify(data);
      db.prepare(
        "INSERT INTO skill_catalog VALUES (1, 7, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        createHash("sha256").update(json).digest("hex"),
        data.buildNumber,
        data.releaseDate,
        data.sourceUrl,
        data.fetchedAt,
        c.checkedAt,
        c.etag,
        json,
      );
    }
  } finally {
    db.close();
  }
}

describe("normalized SQLite skill store", () => {
  it("rejects deleted duplicate-name rows before ambiguity can silently become a unique match", async () => {
    const { store, path, acquire } = await setup();
    const saved = store.publish({
      ...candidate(),
      catalog: new SkillCatalog(
        skillFixture([skill(1, "Same"), skill(2, "Same")]),
      ),
    }).saved;
    const snapshot = acquire();
    expect(snapshot.catalog.resolve("Same").status).toBe("ambiguous");
    edit(path, "DELETE FROM skill_types WHERE id = 2");
    expect(store.read()).toEqual(saved);
    const close = vi.spyOn(DatabaseSync.prototype, "close");
    expect(() => store.acquire()).toThrow("row count mismatch");
    expect(close).toHaveBeenCalledOnce();
    expect(snapshot.catalog.resolve("Same").status).toBe("ambiguous");
  });
  it.each([
    "INSERT INTO skill_types SELECT 999, name, normalized_name, group_id, category_id, published, requirements_available, requirement_count, rank, sha256 FROM skill_types WHERE id = 100",
    "INSERT INTO skill_types SELECT 999, name, normalized_name, group_id, category_id, 0, requirements_available, requirement_count, rank, sha256 FROM skill_types WHERE id = 100",
    "INSERT INTO skill_types SELECT 999, name, normalized_name, group_id, category_id, published, requirements_available, requirement_count, rank, sha256 FROM skill_types WHERE id = 400",
    "UPDATE skill_types SET published = 0 WHERE id = 100",
    "UPDATE skill_types SET category_id = 6 WHERE id = 100",
  ])(
    "reconciles type and published-skill counts before reading any selected row: %s",
    async (sql) => {
      const { store, path } = await setup();
      const saved = store.publish(candidate()).saved;
      edit(path, sql);
      expect(store.read()).toEqual(saved);
      expect(() => store.acquire()).toThrow("row count mismatch");
    },
  );
  it("bounds the request lookup cache instead of retaining all queried types", async () => {
    const { store, acquire } = await setup();
    store.publish(candidate());
    const { catalog } = acquire();
    for (let id = 1000; id < 11_001; id++) catalog.getType(id);
    const prepare = vi.spyOn(DatabaseSync.prototype, "prepare");
    catalog.getType(11_000);
    expect(prepare).not.toHaveBeenCalled();
    catalog.getType(1000);
    expect(prepare).toHaveBeenCalledOnce();
  });
  it("rechecks publication after another writer wins and rolls back failures after row replacement", async () => {
    const { store, directory } = await setup();
    store.publish(candidate());
    let race = true;
    vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (
      this: DatabaseSync,
      sql,
    ) {
      if (race && sql.startsWith("ATTACH DATABASE")) {
        race = false;
        new SkillStore(directory).publish(candidate(125));
      }
      return nativePrepare.call(this, sql);
    });
    expect(() => store.publish(candidate(124))).toThrow(
      "Concurrent SDE publication",
    );
    vi.restoreAllMocks();
    const winner = store.read();
    expect(winner?.metadata.buildNumber).toBe(125);
    vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (
      this: DatabaseSync,
      sql,
    ) {
      nativeExec.call(this, sql);
      if (sql.startsWith("DELETE FROM skill_requirements"))
        throw new Error("synthetic replacement failure");
    });
    expect(() => store.publish(candidate(126))).toThrow("replacement failure");
    expect(store.read()).toEqual(winner);
  });
  it("persists only normalized rows and metadata; all normal reads are bounded queries", async () => {
    const { store, path, acquire } = await setup();
    expect(store.read()).toBeUndefined();
    const first = store.publish(candidate());
    expect(first.accepted).toBe(true);
    expect(first.saved).toMatchObject({
      generation: 1,
      metadata: { typeCount: 4, skillCount: 3 },
    });
    expect(store.read()).toEqual(first.saved);
    const prepare = vi.spyOn(DatabaseSync.prototype, "prepare");
    const snapshot = acquire();
    expect(snapshot.catalog).not.toHaveProperty("data");
    expect(snapshot.catalog).not.toHaveProperty("types");
    expect(snapshot.catalog.resolve("Mining II")).toEqual(
      candidate().catalog.resolve("Mining II"),
    );
    expect(
      buildSkillGraph(snapshot.catalog, [{ skillId: 200, level: 3 }]),
    ).toEqual(
      buildSkillGraph(candidate().catalog, [{ skillId: 200, level: 3 }]),
    );
    store.check(first.saved, "2026-09-07T00:06:00Z", null);
    for (const [sql] of prepare.mock.calls) {
      expect(sql).not.toContain("catalog_json");
      if (sql.includes("FROM skill_types"))
        expect(sql).toMatch(
          /WHERE id = \?|normalized_name = \?|LIMIT|SELECT count\(\*\)/u,
        );
    }
    snapshot.release();
    snapshot.release();
    expect(() => snapshot.catalog.getType(100)).toThrow("closed");
    const db = new DatabaseSync(path);
    try {
      expect(db.prepare("PRAGMA user_version").get()?.user_version).toBe(2);
      expect(
        db
          .prepare("PRAGMA table_info(skill_catalog)")
          .all()
          .map((row) => row.name),
      ).not.toContain("catalog_json");
      expect(
        db
          .prepare("SELECT * FROM skill_requirements WHERE type_id = 200")
          .all(),
      ).toHaveLength(1);
      for (const [query, index] of [
        [
          "SELECT id FROM skill_types WHERE published = 1 AND normalized_name = 'mining' ORDER BY id LIMIT 21",
          "skill_names",
        ],
        ["SELECT id FROM skill_types WHERE id = 100", "INTEGER PRIMARY KEY"],
        [
          "SELECT count(*) FROM skill_types WHERE published = 1 AND category_id = 16",
          "skill_categories",
        ],
        [
          "SELECT * FROM skill_requirements WHERE type_id = 200 ORDER BY position LIMIT 7",
          "sqlite_autoindex_skill_requirements_1",
        ],
      ])
        expect(
          JSON.stringify(db.prepare(`EXPLAIN QUERY PLAN ${query}`).all()),
        ).toContain(index);
      expect(
        db
          .prepare("EXPLAIN SELECT count(*) FROM skill_types")
          .all()
          .some((row) => row.opcode === "Count"),
      ).toBe(true);
    } finally {
      db.close();
    }
  });
  it("preserves a single immutable reader across publication and expires abandoned readers", async () => {
    const { store, acquire } = await setup();
    store.publish(candidate());
    const old = acquire();
    const next = candidate(124);
    next.catalog.data.types = next.catalog.data.types.map((type) =>
      type.id === 100 ? { ...type, name: "Changed" } : type,
    );
    store.publish(next);
    const current = acquire();
    expect(old.catalog.metadata.buildNumber).toBe(123);
    expect(old.catalog.skill(100).name).toBe("Mining");
    expect(current.catalog.skill(100).name).toBe("Changed");
    expect(() => {
      old.catalog.skill(100).name = "mutation";
    }).toThrow();
    vi.useFakeTimers();
    const abandoned = acquire();
    vi.advanceTimersByTime(180_000);
    expect(() => abandoned.catalog.resolve("Mining")).toThrow(
      "closed or expired",
    );
    expect(() => old.catalog.resolve("Mining")).toThrow("closed or expired");
  });
  it("uses JavaScript Unicode folding and bounds global exact ambiguity and suggestions", async () => {
    const { store, acquire } = await setup();
    const c = candidate();
    c.catalog.data.types = [
      skill(1, "MÍNING"),
      skill(2, "İ"),
      ...Array.from({ length: 30 }, (_, i) => ({
        ...skill(39 - i, i % 2 ? "SAME" : "same"),
        categoryId: i === 29 ? 7 : 16,
      })),
      { ...skill(100, "Hidden"), published: false },
    ];
    store.publish(c);
    const { catalog } = acquire();
    expect(catalog.resolve("míning")).toMatchObject({
      status: "resolved",
      typeId: 1,
    });
    expect(catalog.resolve("i\u0307")).toMatchObject({
      status: "resolved",
      typeId: 2,
    });
    const ambiguous = catalog.resolve("Same");
    expect(ambiguous).toMatchObject({
      status: "ambiguous",
      candidates: expect.any(Array),
      candidatesTruncated: true,
    });
    expect(ambiguous).toEqual(new SkillCatalog(c.catalog.data).resolve("Same"));
    if (ambiguous.status !== "ambiguous")
      throw new Error("Expected ambiguous target");
    expect(ambiguous.candidates.map((type) => type.typeId)).toEqual(
      Array.from({ length: 20 }, (_, index) => index + 10),
    );
    expect(catalog.findByName("same")).toHaveLength(21);
    expect(catalog.resolve("Same")).toHaveProperty("candidates.length", 20);
    expect(catalog.search("sam")).toHaveLength(20);
    expect(catalog.resolve("Hidden").status).toBe("unresolved");
    expect(catalog.skill(100).name).toBe("Hidden");
    expect(() => catalog.resolve("x".repeat(201))).toThrow();
    expect(() => catalog.search("x".repeat(601))).toThrow();
    expect(() => catalog.findByName("x".repeat(602))).toThrow();
    expect(() => catalog.getType(NaN)).toThrow();
    expect(catalog.getType(999)).toBeUndefined();
    expect(catalog.getType(999)).toBeUndefined();
    expect(catalog.publishedSkillIds()).toHaveLength(31);
  });
  it.each([false, true])(
    "pins an entire private plan across ESI awaits and releases on success/failure (%s)",
    async (fail) => {
      const { store, acquire } = await setup();
      store.publish(candidate());
      const client = new EsiClient(
        new OperationCatalog(fixtureDocument()),
        new StaticTokenProvider(undefined),
      );
      const next = candidate(124);
      next.catalog.data.types = next.catalog.data.types.map((type) =>
        type.id === 100 ? { ...type, name: "Changed", rank: 2 } : type,
      );
      vi.spyOn(client, "authorize").mockImplementation(async () => {
        store.publish(next);
        await Promise.resolve();
        if (fail) throw new Error("synthetic ESI failure");
        return { authorizationContext: "esi" };
      });
      vi.spyOn(client, "call").mockImplementation((input) =>
        Promise.resolve({
          operationId: input.operationId,
          status: 200,
          url: "https://esi.evetech.net/characters/42/skills",
          cached: false,
          headers: {},
          data: input.operationId.endsWith("Skills")
            ? { skills: [], total_sp: 0 }
            : [],
          freshness: {
            fetchedAt: "2026-09-07T00:00:00Z",
            servedAt: "2026-09-07T00:00:00Z",
            expiresAt: null,
            sourceLastModified: null,
          },
          pagination: {
            mode: "none",
            currentPage: null,
            totalPages: null,
            hasMore: false,
            nextCall: null,
          },
        } satisfies EsiResponse),
      );
      const snapshot = acquire();
      const release = vi.fn(snapshot.release);
      const planner = new SkillPlanner(
        {
          initialize: () =>
            Promise.resolve({
              ...snapshot,
              release,
              status: { buildNumber: snapshot.saved.metadata.buildNumber },
            }),
        },
        client,
      );
      const promise = planner.generate({
        characterId: 42,
        targets: ["Mining II"],
      });
      if (fail) await expect(promise).rejects.toThrow("ESI failure");
      else
        expect(await promise).toMatchObject({
          staticData: { buildNumber: 123 },
          trainingText: "Mining I\nMining II",
          additionalSkillPointsEstimate: 1415,
        });
      expect(release).toHaveBeenCalledOnce();
      expect(() => snapshot.catalog.skill(100)).toThrow("closed");
      expect(acquire().catalog.skill(100).name).toBe("Changed");
    },
  );
  it("retains unavailable requirements, slot order, and unpublished prerequisites", async () => {
    const { store, acquire } = await setup();
    const c = candidate();
    c.catalog.data.types = c.catalog.data.types.map((type) =>
      type.id === 100
        ? { ...type, published: false }
        : type.id === 400
          ? { ...type, requirements: null }
          : type,
    );
    store.publish(c);
    const { catalog } = acquire();
    expect(catalog.getType(400)?.requirements).toBeNull();
    expect(() => catalog.resolve("Test Hull")).toThrow("Missing requirement");
    expect(
      buildSkillGraph(catalog, [{ skillId: 200, level: 1 }]).nodes[0]?.skillId,
    ).toBe(100);
  });
  it("fences monotone builds, checkedAt, generation, content identity, and legacy publication", async () => {
    const { store } = await setup();
    const first = store.publish(candidate(124)).saved;
    expect(store.publish(candidate(123))).toEqual({
      saved: first,
      accepted: false,
    });
    expect(store.publish(candidate(125), true)).toEqual({
      saved: first,
      accepted: false,
    });
    const same = candidate(124);
    same.catalog.data.fetchedAt = "2026-09-07T00:06:00Z";
    expect(store.publish(same).accepted).toBe(false);
    same.catalog.data.types = same.catalog.data.types.map((type) => ({
      ...type,
      name: "Different",
    }));
    expect(() => store.publish(same)).toThrow("Conflicting");
    const release = candidate(124);
    release.catalog.data.releaseDate = "2026-09-02T00:00:00Z";
    expect(() => store.publish(release)).toThrow("Conflicting");
    const next = store.check(first, "2026-09-07T00:06:00Z", '"etag"').saved;
    expect(next.generation).toBe(2);
    expect(next.sha256).toBe(first.sha256);
    for (const expected of [first, { ...next, sha256: "0".repeat(64) }])
      expect(store.check(expected, "2026-09-07T00:07:00Z", null).accepted).toBe(
        false,
      );
    expect(store.check(next, "2026-09-07T00:05:00Z", null).accepted).toBe(
      false,
    );
    expect(store.publish(candidate(125)).saved.checkedAt).toBe(
      "2026-09-07T00:06:00.000Z",
    );
  });
  it("rolls back failed publications and freshness updates; recognizes and retries empty stores", async () => {
    const { store, path } = await setup();
    vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (
      this: DatabaseSync,
      sql,
    ) {
      const statement = nativePrepare.call(this, sql);
      if (sql.startsWith("INSERT OR REPLACE INTO skill_catalog"))
        vi.spyOn(statement, "run").mockImplementation(() => {
          throw new Error("synthetic insert failure");
        });
      return statement;
    });
    expect(() => store.publish(candidate())).toThrow("insert failure");
    expect(store.exists()).toBe(true);
    expect(store.read()).toBeUndefined();
    expect(() => store.publish(candidate(), true)).toThrow("absent database");
    vi.restoreAllMocks();
    const first = store.publish(candidate()).saved;
    vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (
      this: DatabaseSync,
      sql,
    ) {
      if (sql === "COMMIT") throw new Error("synthetic commit failure");
      nativeExec.call(this, sql);
    });
    expect(() => store.check(first, "2026-09-07T00:06:00Z", null)).toThrow(
      "commit failure",
    );
    expect(() => store.publish(candidate(124))).toThrow("commit failure");
    expect(store.read()).toEqual(first);
    expect(
      (await readdir(join(path, ".."))).filter((file) =>
        file.startsWith("skills-import"),
      ),
    ).toEqual([]);
  });
  it.each([
    "PRAGMA user_version=3",
    "PRAGMA user_version=0",
    "PRAGMA application_id=0",
    "CREATE TABLE unexpected (id INTEGER)",
    "DROP TABLE skill_types",
    "UPDATE skill_catalog SET sha256 = 'invalid'",
    "UPDATE skill_catalog SET type_count = 99",
    "UPDATE skill_catalog SET skill_count = 99",
    "UPDATE skill_catalog SET build_number = 999",
    "UPDATE skill_catalog SET checked_at = 'invalid'",
    "UPDATE skill_catalog SET generation = 0",
    "UPDATE skill_catalog SET etag = printf('%5000s', 'x')",
    "UPDATE skill_catalog SET etag = 'good' || char(0) || 'bad'",
    "UPDATE skill_catalog SET fetched_at = fetched_at || char(0)",
    "UPDATE skill_catalog SET release_date = release_date || char(0)",
    "UPDATE skill_catalog SET source_url = source_url || char(0)",
    "UPDATE skill_catalog SET metadata_sha256 = metadata_sha256 || char(0)",
  ])(
    "fails closed on authoritative metadata/schema corruption: %s",
    async (sql) => {
      const { store, path } = await setup();
      store.publish(candidate());
      edit(path, sql);
      const before = await readFile(path);
      expect(() => store.read()).toThrow();
      expect(() => store.publish(candidate(124))).toThrow();
      expect((await readFile(path)).equals(before)).toBe(true);
    },
  );
  it.each([
    "UPDATE skill_types SET name = name || char(0) WHERE id = 100",
    "UPDATE skill_types SET name = CAST(zeroblob(8001) AS TEXT) WHERE id = 100",
    "UPDATE skill_types SET normalized_name = normalized_name || char(0) WHERE id = 100",
    "UPDATE skill_types SET rank = 2 WHERE id = 100",
    "UPDATE skill_types SET published = 2 WHERE id = 100",
    "UPDATE skill_types SET requirements_available = 2 WHERE id = 100",
    "UPDATE skill_types SET requirement_count = 1 WHERE id = 100",
    "UPDATE skill_types SET sha256 = sha256 || char(0) WHERE id = 100",
    "INSERT INTO skill_requirements VALUES (100, 0, 200, 1)",
  ])(
    "checks bounded selected rows rather than trusting SQLite materialization: %s",
    async (sql) => {
      const { store, path, acquire } = await setup();
      store.publish(candidate());
      edit(path, sql);
      expect(() => {
        const { catalog } = acquire();
        catalog.getType(100);
      }).toThrow();
    },
  );
  it("rejects NUL-suffixed schema SQL before native TEXT materialization", async () => {
    const { store } = await setup();
    store.publish(candidate());
    vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (
      this: DatabaseSync,
      sql,
    ) {
      return nativePrepare.call(
        this,
        sql.replace(
          "FROM sqlite_schema WHERE",
          "FROM (SELECT type, name, sql || char(0) AS sql FROM sqlite_schema) WHERE",
        ),
      );
    });
    expect(() => store.read()).toThrow("Invalid SDE database schema");
  });
  it("migrates shipped v1 offline transactionally while preserving freshness and generation", async () => {
    const { store, path, acquire } = await setup();
    legacy(path);
    const saved = store.read();
    expect(saved).toMatchObject({
      generation: 7,
      checkedAt: candidate().checkedAt,
      etag: candidate().etag,
    });
    expect(acquire().catalog.resolve("Mining").status).toBe("resolved");
    const prepare = vi.spyOn(DatabaseSync.prototype, "prepare");
    store.read();
    expect(
      prepare.mock.calls.some(([sql]) => sql.includes("catalog_json")),
    ).toBe(false);
    if (!saved) throw new Error("Missing migrated data");
    expect(
      store.check(saved, "2026-09-07T00:06:00Z", null).saved.generation,
    ).toBe(8);
  });
  it("rolls back migration failures and retries recognized v1 empty databases", async () => {
    const { store, path } = await setup();
    legacy(path);
    vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (
      this: DatabaseSync,
      sql,
    ) {
      if (sql.startsWith("CREATE TABLE skill_catalog"))
        throw new Error("synthetic migration failure");
      nativeExec.call(this, sql);
    });
    expect(() => store.read()).toThrow("migration failure");
    vi.restoreAllMocks();
    const db = new DatabaseSync(path);
    expect(db.prepare("PRAGMA user_version").get()?.user_version).toBe(1);
    db.close();
    expect(store.read()?.generation).toBe(7);
    const empty = await setup();
    legacy(empty.path, true);
    expect(empty.store.read()).toBeUndefined();
    expect(() => empty.store.publish(candidate(), true)).toThrow(
      "absent database",
    );
    expect(empty.store.publish(candidate()).accepted).toBe(true);
  });
  it.each([
    "UPDATE skill_catalog SET catalog_json = '{}'",
    "UPDATE skill_catalog SET catalog_json = catalog_json || char(0)",
    "UPDATE skill_catalog SET catalog_json = CAST(zeroblob(40000001) AS TEXT)",
    "UPDATE skill_catalog SET etag = 'good' || char(0)",
    "UPDATE skill_catalog SET generation = 0",
    "UPDATE skill_catalog SET build_number = 999",
  ])("does not replace invalid v1 state during migration: %s", async (sql) => {
    const { store, path } = await setup();
    legacy(path);
    edit(path, sql);
    const before = await readFile(path);
    expect(() => store.read()).toThrow();
    expect((await readFile(path)).equals(before)).toBe(true);
  });
  it("rejects unversioned/non-database files, invalid input, and incomplete imports", async () => {
    const { store, path, directory } = await setup();
    const stage = new SkillImport(directory, candidate().catalog.data);
    expect(() => stage.result()).toThrow("incomplete");
    stage.dispose();
    expect(() => stage.fromCatalog(skillFixture())).toThrow("closed");
    expect(() =>
      store.publish({ ...candidate(), checkedAt: "invalid" }),
    ).toThrow();
    expect(() =>
      store.publish({ ...candidate(), etag: "bad\netag" }),
    ).toThrow();
    const bad = candidate();
    bad.catalog.data.sourceUrl = "https://example.com/archive.zip";
    expect(() => store.publish(bad)).toThrow("source");
    const huge = candidate();
    huge.catalog.data.types = [skill(100, "x".repeat(40_000_001))];
    expect(() => store.publish(huge)).toThrow("byte limit");
    expect(() =>
      store.check({} as never, "2026-09-07T00:00:00Z", null),
    ).toThrow("missing");
    for (const text of ["", "corrupted database"]) {
      await writeFile(path, text);
      expect(() => store.read()).toThrow();
      expect(() => store.publish(candidate())).toThrow();
      expect(await readFile(path, "utf8")).toBe(text);
    }
  });
});
