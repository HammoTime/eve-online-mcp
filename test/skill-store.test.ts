import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, StatementSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SkillCatalog } from "../src/skill-data.js";
import { SkillStore, skillBuildSourceUrl } from "../src/skill-store.js";
import { skillFixture } from "./skill-fixtures.js";

const directories: string[] = [];
const nativeExec = Reflect.get(DatabaseSync.prototype, "exec");
const nativePrepare = Reflect.get(DatabaseSync.prototype, "prepare");
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "eve-skill-store-"));
  directories.push(directory);
  return {
    directory,
    path: join(directory, "skills-v1.sqlite"),
    store: new SkillStore(directory),
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

describe("SQLite skill catalog store", () => {
  it("initializes only on publication, persists validated JSON/metadata/checksum and closes every connection", async () => {
    const { directory, path, store } = await setup();
    const close = vi.spyOn(DatabaseSync.prototype, "close");
    const exec = vi.spyOn(DatabaseSync.prototype, "exec");
    expect(store.read()).toBeUndefined();
    const first = store.publish(candidate());
    expect(first.accepted).toBe(true);
    expect(first.saved.generation).toBe(1);
    expect(first.saved.sha256).toBe(
      createHash("sha256")
        .update(JSON.stringify(first.saved.catalog.data))
        .digest("hex"),
    );
    expect(new SkillStore(directory).read()).toEqual(first.saved);
    expect(close).toHaveBeenCalledTimes(2);
    expect(exec).toHaveBeenCalledWith(
      "PRAGMA busy_timeout=5000; PRAGMA trusted_schema=OFF",
    );
    expect(exec).toHaveBeenCalledWith(
      "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL",
    );
    expect(exec).toHaveBeenCalledWith("BEGIN IMMEDIATE");
    const db = new DatabaseSync(path);
    try {
      expect(db.prepare("PRAGMA journal_mode").get()?.journal_mode).toBe("wal");
      expect(db.prepare("PRAGMA user_version").get()?.user_version).toBe(1);
      expect(
        db.prepare("SELECT build_number, source_url FROM skill_catalog").get(),
      ).toMatchObject({
        build_number: 123,
        source_url: candidate().catalog.data.sourceUrl,
      });
    } finally {
      db.close();
    }
  });

  it("keeps a newer build against an older writer and imports legacy only into an absent store", async () => {
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
    expect(store.read()).toEqual(first);
  });

  it.each(["content", "release"])(
    "rejects conflicting same-build %s without changing the current build",
    async (field) => {
      const { store } = await setup();
      const first = store.publish(candidate()).saved;
      const conflicting = candidate();
      if (field === "content")
        conflicting.catalog.data.types = conflicting.catalog.data.types.map(
          (type) => ({ ...type, name: `${type.name} changed` }),
        );
      else conflicting.catalog.data.releaseDate = "2026-09-02T00:00:00Z";
      expect(() => store.publish(conflicting)).toThrow("Conflicting");
      expect(store.read()).toEqual(first);
    },
  );

  it("does not treat independent fetch timestamps as conflicting content or refresh an unfenced same-build download", async () => {
    const { store } = await setup();
    const first = store.publish(candidate()).saved;
    const concurrent = candidate(123, "2026-09-07T00:06:00Z");
    concurrent.catalog.data.fetchedAt = concurrent.checkedAt;
    expect(store.publish(concurrent)).toEqual({
      saved: first,
      accepted: false,
    });
    expect(store.read()).toEqual(first);
  });

  it("fences freshness by both generation and digest and never decreases checkedAt", async () => {
    const { store } = await setup();
    const first = store.publish(candidate()).saved;
    const checked = store.check(
      first,
      "2026-09-07T00:06:00Z",
      '"new-etag"',
    ).saved;
    expect(checked.generation).toBe(2);
    expect(checked.sha256).toBe(first.sha256);
    expect(store.check(first, "2026-09-07T00:07:00Z", '"stale"')).toEqual({
      saved: checked,
      accepted: false,
    });
    expect(
      store.check(
        { ...checked, sha256: "0".repeat(64) },
        "2026-09-07T00:07:00Z",
        null,
      ).accepted,
    ).toBe(false);
    expect(store.check(checked, "2026-09-07T00:05:00Z", null).accepted).toBe(
      false,
    );
    const next = store.publish(candidate(124, "2026-09-07T00:04:00Z")).saved;
    expect(next.checkedAt).toBe("2026-09-07T00:06:00.000Z");
    expect(store.check(checked, "2026-09-07T00:08:00Z", null)).toEqual({
      saved: next,
      accepted: false,
    });
    expect(store.read()).toEqual(next);
  });

  it("rolls back failed catalog and freshness commits, preserving data and checkedAt", async () => {
    const { store } = await setup();
    const first = store.publish(candidate()).saved;
    const exec = vi.spyOn(DatabaseSync.prototype, "exec");
    exec.mockImplementation(function (this: DatabaseSync, sql: string) {
      if (sql === "COMMIT") throw new Error("synthetic publication failure");
      nativeExec.call(this, sql);
    });
    expect(() => store.publish(candidate(124))).toThrow("publication failure");
    expect(store.read()).toEqual(first);
    expect(() => store.check(first, "2026-09-07T00:06:00Z", null)).toThrow(
      "publication failure",
    );
    expect(store.read()).toEqual(first);
    expect(exec).toHaveBeenCalledWith("ROLLBACK");
  });

  it.each([false, true])(
    "retries a failed first INSERT without replacing the database (restart=%s)",
    async (restart) => {
      const { store, path, directory } = await setup();
      vi.spyOn(StatementSync.prototype, "run").mockImplementationOnce(() => {
        throw new Error("synthetic INSERT failure");
      });
      expect(() => store.publish(candidate())).toThrow("INSERT failure");
      const before = await stat(path);
      expect(store.exists()).toBe(true);
      expect(store.read()).toBeUndefined();
      const db = new DatabaseSync(path);
      try {
        expect(db.prepare("PRAGMA user_version").get()?.user_version).toBe(1);
        expect(
          db.prepare("SELECT count(*) AS count FROM skill_catalog").get()
            ?.count,
        ).toBe(0);
      } finally {
        db.close();
      }
      expect(() => store.publish(candidate(), true)).toThrow("absent database");
      const retry = restart ? new SkillStore(directory) : store;
      const result = retry.publish(candidate(124));
      expect(result.accepted).toBe(true);
      expect(result.saved.generation).toBe(1);
      expect(retry.read()).toEqual(result.saved);
      expect((await stat(path)).ino).toBe(before.ino);
    },
  );

  it.each([false, true])(
    "accepts a concurrent initializer's valid schema without replacing its data (published=%s)",
    async (published) => {
      const seed = await setup();
      seed.store.publish(candidate());
      const template = new DatabaseSync(seed.path, { readOnly: true });
      let schema: string;
      try {
        const sql = template
          .prepare("SELECT sql FROM sqlite_schema WHERE name = 'skill_catalog'")
          .get()?.sql;
        if (typeof sql !== "string") throw new Error("Missing test schema");
        schema = sql;
      } finally {
        template.close();
      }
      const { store, path, directory } = await setup();
      const exec = vi.spyOn(DatabaseSync.prototype, "exec");
      let race = true;
      exec.mockImplementation(function (this: DatabaseSync, sql: string) {
        if (race && sql === "BEGIN IMMEDIATE") {
          race = false;
          const other = new DatabaseSync(path);
          try {
            other.exec(
              `${schema}; PRAGMA application_id=1163285323; PRAGMA user_version=1`,
            );
          } finally {
            other.close();
          }
          if (published) new SkillStore(directory).publish(candidate(125));
        }
        nativeExec.call(this, sql);
      });
      const result = store.publish(candidate(124));
      expect(result.accepted).toBe(!published);
      expect(result.saved.catalog.data.buildNumber).toBe(published ? 125 : 124);
      expect(store.read()).toEqual(result.saved);
    },
  );

  it("rechecks the winner under BEGIN IMMEDIATE rather than trusting an earlier read", async () => {
    const { store, directory } = await setup();
    store.publish(candidate());
    const exec = vi.spyOn(DatabaseSync.prototype, "exec");
    let race = true;
    exec.mockImplementation(function (this: DatabaseSync, sql: string) {
      if (race && sql.includes("BEGIN IMMEDIATE")) {
        race = false;
        new SkillStore(directory).publish(candidate(125));
      }
      nativeExec.call(this, sql);
    });
    expect(() => store.publish(candidate(124))).toThrow(
      "Concurrent SDE publication",
    );
    expect(store.read()?.catalog.data.buildNumber).toBe(125);
  });

  it.each([
    "PRAGMA user_version=2",
    "PRAGMA user_version=0",
    "PRAGMA application_id=0",
    "CREATE TABLE unexpected (id INTEGER)",
    "DROP TABLE skill_catalog",
    "UPDATE skill_catalog SET sha256 = 'invalid'",
    "UPDATE skill_catalog SET catalog_json = '{}'",
    "UPDATE skill_catalog SET build_number = 999",
    "UPDATE skill_catalog SET source_url = 'https://example.com/archive.zip'",
    "UPDATE skill_catalog SET checked_at = 'invalid'",
    "UPDATE skill_catalog SET generation = 0",
    "UPDATE skill_catalog SET etag = printf('%5000s', 'x')",
    "UPDATE skill_catalog SET etag = 'good' || char(0) || 'bad'",
    "UPDATE skill_catalog SET checked_at = checked_at || char(0) || 'bad'",
    "UPDATE skill_catalog SET fetched_at = fetched_at || char(0) || 'bad'",
    "UPDATE skill_catalog SET release_date = release_date || char(0) || 'bad'",
    "UPDATE skill_catalog SET source_url = source_url || char(0) || 'bad'",
    "UPDATE skill_catalog SET catalog_json = catalog_json || char(0) || 'bad'",
    "UPDATE skill_catalog SET catalog_json = CAST(zeroblob(40000001) AS TEXT)",
  ])(
    "fails closed on invalid persisted state (%s) without overwriting it",
    async (sql) => {
      const { store, path } = await setup();
      store.publish(candidate());
      edit(path, sql);
      const before = await readFile(path);
      expect(() => store.read()).toThrow();
      expect(() => store.publish(candidate(124))).toThrow();
      // Deep equality enumerates millions of Buffer indices; compare bytes natively.
      expect((await readFile(path)).equals(before)).toBe(true);
    },
  );

  it("rejects NUL-suffixed schema SQL before native TEXT materialization", async () => {
    const { store, path } = await setup();
    store.publish(candidate());
    const before = await readFile(path);
    vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (
      this: DatabaseSync,
      sql: string,
    ) {
      // Inject the corrupt TEXT in SQLite rather than disabling defensive mode
      // to modify sqlite_schema. The actual bounded SELECT still validates it.
      return nativePrepare.call(
        this,
        sql.replace(
          "FROM sqlite_schema WHERE",
          "FROM (SELECT type, name, sql || char(0) || 'bad' AS sql FROM sqlite_schema) WHERE",
        ),
      );
    });
    expect(() => store.read()).toThrow("Invalid SDE database schema");
    expect(() => store.publish(candidate(124))).toThrow(
      "Invalid SDE database schema",
    );
    expect((await readFile(path)).equals(before)).toBe(true);
  });

  it.each(["source", "schema", "structure"])(
    "validates cached catalog %s even with a matching checksum",
    async (failure) => {
      const { store, path } = await setup();
      store.publish(candidate());
      const data = {
        ...skillFixture(),
        ...(failure === "source"
          ? { sourceUrl: "https://example.com/archive.zip" }
          : {}),
        ...(failure === "schema" ? { schemaVersion: 2 } : {}),
        ...(failure === "structure" ? { types: [] } : {}),
      };
      const json = JSON.stringify(data);
      const db = new DatabaseSync(path);
      try {
        db.prepare("UPDATE skill_catalog SET catalog_json = ?, sha256 = ?").run(
          json,
          createHash("sha256").update(json).digest("hex"),
        );
      } finally {
        db.close();
      }
      expect(() => store.read()).toThrow();
    },
  );

  it("never initializes an existing unversioned or non-SQLite file", async () => {
    const { store, path } = await setup();
    for (const text of ["", "corrupted database"]) {
      await writeFile(path, text);
      expect(() => store.read()).toThrow();
      expect(() => store.publish(candidate())).toThrow();
      expect(await readFile(path, "utf8")).toBe(text);
    }
  });

  it("rejects invalid publication inputs and missing freshness targets", async () => {
    const { store, path } = await setup();
    const valid = candidate();
    expect(() => store.publish({ ...valid, checkedAt: "invalid" })).toThrow();
    expect(() => store.publish({ ...valid, etag: "bad\netag" })).toThrow();
    const badSource = candidate();
    badSource.catalog.data.sourceUrl = "https://example.com/archive.zip";
    expect(() => store.publish(badSource)).toThrow("source");
    const oversized = candidate();
    oversized.catalog.data.types = oversized.catalog.data.types.map(
      (type, index) =>
        index === 0 ? { ...type, name: "x".repeat(40_000_001) } : type,
    );
    expect(() => store.publish(oversized)).toThrow("byte limit");
    const first = store.publish(valid).saved;
    expect(() => store.check(first, "invalid", null)).toThrow();
    await rm(path);
    expect(() => store.check(first, valid.checkedAt, null)).toThrow("missing");
  });
});
