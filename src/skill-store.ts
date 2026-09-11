import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import * as z from "zod/v4";
import { SkillCatalog, type StaticCatalog, typeId } from "./skill-data.js";

const MAX_CATALOG_BYTES = 40_000_000;
const APPLICATION_ID = 0x4556534b;
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const timestampSchema = z.iso.datetime().max(64);
const freshnessSchema = z.object({
  checkedAt: timestampSchema,
  etag: z
    .string()
    .max(4096)
    .refine(
      (value) =>
        !value.includes("\r") && !value.includes("\n") && !value.includes("\0"),
    )
    .nullable(),
});
const rowSchema = freshnessSchema.extend({
  generation: typeId,
  sha256: digestSchema,
  buildNumber: typeId,
  releaseDate: timestampSchema,
  sourceUrl: z.string().max(256),
  fetchedAt: timestampSchema,
  catalogJson: z.string(),
});
const TABLE = `CREATE TABLE skill_catalog (
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

export interface SavedSkills {
  catalog: SkillCatalog;
  checkedAt: string;
  etag: string | null;
  generation: number;
  sha256: string;
}

export function skillBuildSourceUrl(build: number): string {
  return `https://developers.eveonline.com/static-data/tranquility/eve-online-static-data-${build}-jsonl.zip`;
}

function digest(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function validatedCatalog(value: unknown): SkillCatalog {
  const catalog = new SkillCatalog(value as StaticCatalog);
  timestampSchema.parse(catalog.data.releaseDate);
  timestampSchema.parse(catalog.data.fetchedAt);
  if (catalog.data.sourceUrl !== skillBuildSourceUrl(catalog.data.buildNumber))
    throw new Error("Invalid SDE build source");
  return catalog;
}

function exists(path: string): boolean {
  try {
    if (!statSync(path).isFile()) throw new Error("Invalid SDE database path");
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function boundedText(column: string, bytes: number): string {
  // Node 22.13 truncates SQLite TEXT at NUL during materialization. Reject it in
  // SQL, including nullable fields and schema SQL, before checksum/Zod checks.
  return `CASE WHEN ${column} IS NULL THEN NULL
    WHEN typeof(${column}) = 'text' AND length(CAST(${column} AS BLOB)) <= ${bytes}
      AND instr(${column}, char(0)) = 0
    THEN ${column} ELSE 0 END`;
}

function checkSchema(db: DatabaseSync) {
  if (
    db.prepare("PRAGMA user_version").get()?.user_version !== 1 ||
    db.prepare("PRAGMA application_id").get()?.application_id !== APPLICATION_ID
  )
    throw new Error("Unsupported SDE database version");
  const schema = db
    .prepare(
      `SELECT ${boundedText("type", 6)} AS type,
        ${boundedText("name", 64)} AS name, ${boundedText("sql", 4096)} AS sql
      FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' LIMIT 2`,
    )
    .all();
  if (
    schema.length !== 1 ||
    schema[0]?.type !== "table" ||
    schema[0].name !== "skill_catalog" ||
    schema[0].sql !== TABLE
  )
    throw new Error("Invalid SDE database schema");
}

function readSaved(db: DatabaseSync): SavedSkills | undefined {
  // Bound values in SQL before SQLite copies them into JavaScript memory.
  const rows = db
    .prepare(
      `SELECT id, generation, ${boundedText("sha256", 64)} AS sha256,
        build_number AS buildNumber,
        ${boundedText("release_date", 64)} AS releaseDate,
        ${boundedText("source_url", 256)} AS sourceUrl,
        ${boundedText("fetched_at", 64)} AS fetchedAt,
        ${boundedText("checked_at", 64)} AS checkedAt,
        ${boundedText("etag", 4096)} AS etag,
        ${boundedText("catalog_json", MAX_CATALOG_BYTES)} AS catalogJson
      FROM skill_catalog LIMIT 2`,
    )
    .all();
  if (!rows.length) return undefined;
  if (rows.length !== 1 || rows[0]?.id !== 1)
    throw new Error("Invalid SDE database rows");
  const row = rowSchema.parse(rows[0]);
  if (digest(row.catalogJson) !== row.sha256)
    throw new Error("SDE cache checksum mismatch");
  const catalog = validatedCatalog(JSON.parse(row.catalogJson));
  if (
    catalog.data.buildNumber !== row.buildNumber ||
    catalog.data.releaseDate !== row.releaseDate ||
    catalog.data.sourceUrl !== row.sourceUrl ||
    catalog.data.fetchedAt !== row.fetchedAt
  )
    throw new Error("SDE cache metadata mismatch");
  return {
    catalog,
    checkedAt: row.checkedAt,
    etag: row.etag,
    generation: row.generation,
    sha256: row.sha256,
  };
}

/** Connections and write locks never span an await, download, or archive parse. */
export class SkillStore {
  private readonly path: string;
  constructor(private readonly directory: string) {
    this.path = join(directory, "skills-v1.sqlite");
  }

  exists(): boolean {
    return exists(this.path);
  }

  read(): SavedSkills | undefined {
    if (!this.exists()) return undefined;
    const db = new DatabaseSync(this.path, { readOnly: true });
    try {
      db.exec("PRAGMA busy_timeout=5000; PRAGMA trusted_schema=OFF");
      checkSchema(db);
      return readSaved(db);
    } finally {
      db.close();
    }
  }

  async readLegacy() {
    const file = await open(join(this.directory, "catalog-v1.json"), "r");
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > MAX_CATALOG_BYTES)
        throw new Error("SDE cache exceeds byte limit");
      const buffer = Buffer.alloc(info.size + 1);
      let size = 0;
      for (;;) {
        const { bytesRead } = await file.read(
          buffer,
          size,
          buffer.length - size,
          null,
        );
        if (!bytesRead) break;
        size += bytesRead;
        if (size === buffer.length)
          throw new Error("SDE cache changed during read");
      }
      const saved = freshnessSchema
        .extend({ sha256: digestSchema, catalog: z.unknown() })
        .strict()
        .parse(JSON.parse(buffer.toString("utf8", 0, size)));
      if (digest(JSON.stringify(saved.catalog)) !== saved.sha256)
        throw new Error("SDE cache checksum mismatch");
      return {
        catalog: validatedCatalog(saved.catalog),
        checkedAt: saved.checkedAt,
        etag: saved.etag,
      };
    } finally {
      await file.close();
    }
  }

  private write(
    create: boolean,
    update: (
      current: SavedSkills | undefined,
      created: boolean,
    ) => {
      saved: SavedSkills;
      accepted: boolean;
      json?: string;
    },
  ) {
    const present = this.exists();
    if (!present && !create) throw new Error("SDE database is missing");
    const db = new DatabaseSync(this.path);
    try {
      db.exec("PRAGMA busy_timeout=5000; PRAGMA trusted_schema=OFF");
      const version = db.prepare("PRAGMA user_version").get()?.user_version;
      const initialize = !present && version === 0;
      if (!initialize) checkSchema(db);
      db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL");
      let created = false;
      if (initialize) {
        // Commit a recognized empty store independently so failed first inserts
        // can retry without accepting arbitrary pre-existing version-zero files.
        db.exec("BEGIN IMMEDIATE");
        try {
          if (db.prepare("PRAGMA user_version").get()?.user_version === 0) {
            if (
              db.prepare("PRAGMA application_id").get()?.application_id !== 0 ||
              db.prepare("SELECT 1 FROM sqlite_schema LIMIT 1").get()
            )
              throw new Error("Invalid SDE database schema");
            db.exec(
              `${TABLE}; PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=1`,
            );
            created = true;
          } else {
            checkSchema(db);
          }
          db.exec("COMMIT");
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      }
      const current = readSaved(db);
      // Validate/serialize large catalogs before taking the publication lock.
      const result = update(current, created);
      db.exec("BEGIN IMMEDIATE");
      try {
        checkSchema(db);
        const actual = db
          .prepare(
            `SELECT generation, ${boundedText("sha256", 64)} AS sha256,
              build_number FROM skill_catalog WHERE id = 1`,
          )
          .get();
        if (
          actual?.generation !== current?.generation ||
          actual?.sha256 !== current?.sha256 ||
          actual?.build_number !== current?.catalog.data.buildNumber
        )
          throw new Error("Concurrent SDE publication");
        if (result.accepted) {
          const { saved } = result;
          if (result.json !== undefined) {
            db.prepare(
              `INSERT OR REPLACE INTO skill_catalog
              (id, generation, sha256, build_number, release_date, source_url,
                fetched_at, checked_at, etag, catalog_json)
              VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            ).run(
              saved.generation,
              saved.sha256,
              saved.catalog.data.buildNumber,
              saved.catalog.data.releaseDate,
              saved.catalog.data.sourceUrl,
              saved.catalog.data.fetchedAt,
              saved.checkedAt,
              saved.etag,
              result.json,
            );
          } else {
            db.prepare(
              "UPDATE skill_catalog SET generation = ?, checked_at = ?, etag = ? WHERE id = 1",
            ).run(saved.generation, saved.checkedAt, saved.etag);
          }
        }
        db.exec("COMMIT");
        return { saved: result.saved, accepted: result.accepted };
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    } finally {
      db.close();
    }
  }

  publish(
    candidate: {
      catalog: SkillCatalog;
      checkedAt: string;
      etag: string | null;
    },
    onlyIfAbsent = false,
  ) {
    const freshness = freshnessSchema.parse(candidate);
    const raw = JSON.stringify(candidate.catalog.data);
    if (Buffer.byteLength(raw) > MAX_CATALOG_BYTES)
      throw new Error("SDE cache exceeds byte limit");
    const catalog = validatedCatalog(JSON.parse(raw));
    const json = JSON.stringify(catalog.data);
    const sha256 = digest(json);
    return this.write(true, (current, created) => {
      if (onlyIfAbsent) {
        if (current) return { saved: current, accepted: false };
        if (!created)
          throw new Error("Legacy import requires an absent database");
      }
      if (
        current &&
        current.catalog.data.buildNumber >= catalog.data.buildNumber
      ) {
        if (
          current.catalog.data.buildNumber === catalog.data.buildNumber &&
          digest(
            JSON.stringify({ ...current.catalog.data, fetchedAt: null }),
          ) !== digest(JSON.stringify({ ...catalog.data, fetchedAt: null }))
        )
          throw new Error("Conflicting SDE build identity");
        return { saved: current, accepted: false };
      }
      return {
        saved: {
          catalog,
          sha256,
          generation: typeId.parse((current?.generation ?? 0) + 1),
          checkedAt: new Date(
            Math.max(
              Date.parse(freshness.checkedAt),
              current ? Date.parse(current.checkedAt) : -Infinity,
            ),
          ).toISOString(),
          etag: freshness.etag,
        },
        accepted: true,
        json,
      };
    });
  }

  check(expected: SavedSkills, checkedAt: string, etag: string | null) {
    const freshness = freshnessSchema.parse({ checkedAt, etag });
    return this.write(false, (current) => {
      if (!current) throw new Error("SDE database is empty");
      if (
        current.generation !== expected.generation ||
        current.sha256 !== expected.sha256 ||
        Date.parse(freshness.checkedAt) < Date.parse(current.checkedAt)
      )
        return { saved: current, accepted: false };
      return {
        saved: {
          ...current,
          ...freshness,
          generation: typeId.parse(current.generation + 1),
        },
        accepted: true,
      };
    });
  }
}
