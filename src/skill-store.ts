import { createHash, randomUUID } from "node:crypto";
import { statSync, unlinkSync } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import * as z from "zod/v4";
import {
  SkillReader,
  type SkillCatalog,
  type SkillMetadata,
  type StaticCatalog,
  type StaticType,
  staticTypeSchema,
  typeId,
  validateCatalog,
} from "./skill-data.js";
import {
  decodeDogma,
  groupSchema,
  typeSchema,
  STATIC_DATA_FILES,
  type StaticDataEntry,
} from "../lib/src/static-data-parser.js";

const MAX_CATALOG_BYTES = 40_000_000;
const APPLICATION_ID = 0x4556534b;
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const timestampSchema = z.iso.datetime().max(64);
const freshnessSchema = z.object({
  checkedAt: timestampSchema,
  etag: z
    .string()
    .max(4096)
    .refine((value) => !/[\r\n\0]/u.test(value))
    .nullable(),
});
const metadataSchema = z.object({
  schemaVersion: z.literal(1),
  buildNumber: typeId,
  releaseDate: timestampSchema,
  sourceUrl: z.string().max(256),
  fetchedAt: timestampSchema,
  typeCount: z.number().int().min(1).max(200_000),
  skillCount: z.number().int().min(0).max(200_000),
});
const savedSchema = freshnessSchema.extend({
  generation: typeId,
  sha256: digestSchema,
  metadata: metadataSchema,
});
export type SavedSkills = z.infer<typeof savedSchema>;
export type SkillBuild = Omit<StaticCatalog, "schemaVersion" | "types">;

// Exact shipped v1 schema. Migration is the only SQLite path allowed to read its blob.
const V1_TABLE = `CREATE TABLE skill_catalog (
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
const SCHEMA = [
  `CREATE TABLE skill_catalog (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  generation INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  build_number INTEGER NOT NULL,
  release_date TEXT NOT NULL,
  source_url TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  checked_at TEXT NOT NULL,
  etag TEXT,
  type_count INTEGER NOT NULL,
  skill_count INTEGER NOT NULL,
  metadata_sha256 TEXT NOT NULL
) STRICT`,
  `CREATE TABLE skill_types (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  group_id INTEGER NOT NULL,
  category_id INTEGER NOT NULL,
  published INTEGER NOT NULL,
  requirements_available INTEGER NOT NULL,
  requirement_count INTEGER NOT NULL,
  rank REAL,
  sha256 TEXT NOT NULL
) STRICT`,
  `CREATE TABLE skill_requirements (
  type_id INTEGER NOT NULL,
  position INTEGER NOT NULL,
  skill_id INTEGER NOT NULL,
  level INTEGER NOT NULL,
  PRIMARY KEY (type_id, position)
) STRICT`,
  `CREATE INDEX skill_names ON skill_types (normalized_name, id) WHERE published = 1`,
  `CREATE INDEX skill_categories ON skill_types (category_id, id) WHERE published = 1`,
];

export function skillBuildSourceUrl(build: number): string {
  return `https://developers.eveonline.com/static-data/tranquility/eve-online-static-data-${build}-jsonl.zip`;
}
function digest(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
function validateBuild(metadata: SkillBuild) {
  const parsed = metadataSchema
    .omit({ typeCount: true, skillCount: true })
    .parse({ schemaVersion: 1, ...metadata });
  if (parsed.sourceUrl !== skillBuildSourceUrl(parsed.buildNumber))
    throw new Error("Invalid SDE build source");
  return parsed;
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
  // Node 22.13 truncates TEXT at NUL. Check bytes and NUL in SQL, before materialization.
  return `CASE WHEN ${column} IS NULL THEN NULL
    WHEN typeof(${column}) = 'text' AND length(CAST(${column} AS BLOB)) <= ${bytes}
      AND instr(${column}, char(0)) = 0
    THEN ${column} ELSE 0 END`;
}
function configure(db: DatabaseSync) {
  db.exec(
    "PRAGMA busy_timeout=5000; PRAGMA trusted_schema=OFF; PRAGMA cache_size=-2048; PRAGMA temp_store=FILE",
  );
}
function checkSchema(db: DatabaseSync, version = 2) {
  if (
    db.prepare("PRAGMA user_version").get()?.user_version !== version ||
    db.prepare("PRAGMA application_id").get()?.application_id !== APPLICATION_ID
  )
    throw new Error("Unsupported SDE database version");
  const schema = db
    .prepare(
      `SELECT ${boundedText("type", 6)} AS type, ${boundedText("name", 64)} AS name,
        ${boundedText("sql", 4096)} AS sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY name LIMIT 7`,
    )
    .all();
  const expected = (version === 1 ? [V1_TABLE] : SCHEMA).map((sql) => ({
    type: sql.startsWith("CREATE TABLE") ? "table" : "index",
    name: sql.split(" ")[2],
    sql,
  }));
  if (
    schema.length !== expected.length ||
    schema.some(
      (row) =>
        !expected.some(
          (item) =>
            row.type === item.type &&
            row.name === item.name &&
            row.sql === item.sql,
        ),
    )
  )
    throw new Error("Invalid SDE database schema");
}
function createSchema(db: DatabaseSync) {
  db.exec(
    `${SCHEMA.join(";")}; PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=2`,
  );
}
function transaction<T>(db: DatabaseSync, run: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = run();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
function readSaved(db: DatabaseSync): SavedSkills | undefined {
  const rows = db
    .prepare(
      `SELECT id, generation, ${boundedText("sha256", 64)} AS sha256,
    build_number AS buildNumber, ${boundedText("release_date", 64)} AS releaseDate,
    ${boundedText("source_url", 256)} AS sourceUrl, ${boundedText("fetched_at", 64)} AS fetchedAt,
    ${boundedText("checked_at", 64)} AS checkedAt, ${boundedText("etag", 4096)} AS etag,
    type_count AS typeCount, skill_count AS skillCount,
    ${boundedText("metadata_sha256", 64)} AS metadataSha256 FROM skill_catalog LIMIT 2`,
    )
    .all();
  if (!rows.length) {
    if (
      db.prepare("SELECT 1 FROM skill_types LIMIT 1").get() ||
      db.prepare("SELECT 1 FROM skill_requirements LIMIT 1").get()
    )
      throw new Error("Invalid empty SDE database");
    return undefined;
  }
  const row = rows[0];
  if (rows.length !== 1 || row?.id !== 1)
    throw new Error("Invalid SDE database rows");
  const saved = savedSchema.parse({
    ...row,
    metadata: { ...row, schemaVersion: 1 },
  });
  validateBuild(saved.metadata);
  if (
    saved.metadata.skillCount > saved.metadata.typeCount ||
    digest(JSON.stringify(saved)) !== row.metadataSha256
  )
    throw new Error("SDE cache metadata checksum mismatch");
  return saved;
}
function writeSaved(db: DatabaseSync, saved: SavedSkills) {
  saved = savedSchema.parse(saved);
  const m = saved.metadata;
  db.prepare(
    `INSERT OR REPLACE INTO skill_catalog VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    saved.generation,
    saved.sha256,
    m.buildNumber,
    m.releaseDate,
    m.sourceUrl,
    m.fetchedAt,
    saved.checkedAt,
    saved.etag,
    m.typeCount,
    m.skillCount,
    digest(JSON.stringify(saved)),
  );
}
function insertType(db: DatabaseSync, value: unknown) {
  const type = staticTypeSchema.parse(value);
  if (
    type.categoryId === 16 &&
    type.published &&
    (type.requirements === null || type.rank === null)
  )
    throw new Error(`Incomplete skill metadata: ${type.id}`);
  db.prepare(
    "INSERT INTO skill_types VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    type.id,
    type.name,
    type.name.toLowerCase(),
    type.groupId,
    type.categoryId,
    Number(type.published),
    Number(type.requirements !== null),
    type.requirements?.length ?? 0,
    type.rank,
    digest(JSON.stringify(type)),
  );
  const insert = db.prepare(
    "INSERT INTO skill_requirements VALUES (?, ?, ?, ?)",
  );
  type.requirements?.forEach((req, position) =>
    insert.run(type.id, position, req.skillId, req.level),
  );
}
const TYPE_COLUMNS = `id, ${boundedText("name", 8000)} AS name, ${boundedText("normalized_name", 24000)} AS normalizedName,
  group_id AS groupId, category_id AS categoryId, published, requirements_available AS available,
  requirement_count AS requirementCount, rank, ${boundedText("sha256", 64)} AS sha256`;
function readType(db: DatabaseSync, row: Record<string, unknown>): StaticType {
  const reqs = db
    .prepare(
      "SELECT r.position, r.skill_id AS skillId, r.level, t.category_id AS categoryId FROM skill_requirements r LEFT JOIN skill_types t ON t.id = r.skill_id WHERE r.type_id = ? ORDER BY r.position LIMIT 7",
    )
    .all(typeId.parse(row.id));
  if (
    ![0, 1].includes(Number(row.published)) ||
    ![0, 1].includes(Number(row.available)) ||
    reqs.length !== row.requirementCount ||
    (!row.available && reqs.length) ||
    reqs.some(
      (req, position) => req.position !== position || req.categoryId !== 16,
    )
  )
    throw new Error("Invalid SDE requirement rows");
  const type = staticTypeSchema.parse({
    ...row,
    published: row.published === 1,
    requirements: row.available === 1 ? reqs : null,
  });
  if (
    type.name.toLowerCase() !== row.normalizedName ||
    digest(JSON.stringify(type)) !== row.sha256
  )
    throw new Error("SDE type checksum mismatch");
  if (
    type.categoryId === 16 &&
    type.published &&
    (type.requirements === null || type.rank === null)
  )
    throw new Error("Incomplete skill metadata");
  return type;
}

/** One bounded read transaction, never a write transaction across network awaits. */
export class SqlSkillReader extends SkillReader {
  readonly metadata: SkillMetadata;
  private readonly cache = new Map<number, StaticType | undefined>();
  private closed = false;
  private readonly expires = Date.now() + 180_000;
  private readonly timer: ReturnType<typeof setTimeout>;
  constructor(
    private readonly db: DatabaseSync,
    saved: SavedSkills,
  ) {
    super();
    this.metadata = Object.freeze({ ...saved.metadata });
    this.timer = setTimeout(() => {
      this.release();
    }, 180_000);
    this.timer.unref();
  }
  release = () => {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.timer);
    this.cache.clear();
    this.db.close();
  };
  private check() {
    if (Date.now() >= this.expires) this.release();
    if (this.closed)
      throw new Error("SDE snapshot is closed or expired; retry the operation");
  }
  getType(id: number) {
    this.check();
    typeId.parse(id);
    if (this.cache.has(id)) return this.cache.get(id);
    const row = this.db
      .prepare(`SELECT ${TYPE_COLUMNS} FROM skill_types WHERE id = ?`)
      .get(id);
    const value = row ? readType(this.db, row) : undefined;
    if (value) {
      value.requirements?.forEach(Object.freeze);
      if (value.requirements) Object.freeze(value.requirements);
      Object.freeze(value);
    }
    const oldest = this.cache.keys().next().value;
    if (this.cache.size >= 10_000 && oldest !== undefined)
      this.cache.delete(oldest);
    this.cache.set(id, value);
    return value;
  }
  findByName(name: string, skillsOnly = false) {
    this.check();
    z.string().max(601).parse(name);
    const rows = this.db
      .prepare(
        `SELECT id FROM skill_types WHERE published = 1 AND normalized_name = ? ${skillsOnly ? "AND category_id = 16" : ""} ORDER BY id LIMIT 21`,
      )
      .all(name);
    return rows.map((row) => {
      const type = this.getType(typeId.parse(row.id));
      if (
        !type ||
        !type.published ||
        type.name.toLowerCase() !== name ||
        (skillsOnly && type.categoryId !== 16)
      )
        throw new Error("SDE name index mismatch");
      return type;
    });
  }
  search(query: string) {
    this.check();
    z.string().max(600).parse(query);
    const name = query.toLowerCase();
    return this.db
      .prepare(
        "SELECT id FROM skill_types WHERE published = 1 AND category_id IN (6, 16) AND instr(normalized_name, ?) > 0 ORDER BY id LIMIT 20",
      )
      .all(name)
      .map((row) => {
        const type = this.getType(typeId.parse(row.id));
        if (
          !type ||
          !type.published ||
          ![6, 16].includes(type.categoryId) ||
          !type.name.toLowerCase().includes(name)
        )
          throw new Error("SDE suggestion index mismatch");
        return {
          typeId: type.id,
          name: type.name,
          categoryId: type.categoryId,
        };
      });
  }
  /** Explicit offline verification only; serving paths never enumerate skill IDs. */
  publishedSkillIds() {
    this.check();
    const rows = this.db
      .prepare(
        "SELECT id FROM skill_types WHERE published = 1 AND category_id = 16 ORDER BY id LIMIT 10001",
      )
      .all();
    if (rows.length > 10_000)
      throw new Error("Skill verification exceeds limit");
    return rows.map((row) => typeId.parse(row.id));
  }
}

/** Disk staging keeps only one bounded JSONL batch and one selected row in JS. */
export class SkillImport {
  readonly path: string;
  private db: DatabaseSync | undefined;
  private complete: { metadata: SkillMetadata; sha256: string } | undefined;
  private readonly metadata: ReturnType<typeof validateBuild>;
  constructor(directory: string, metadata: SkillBuild) {
    this.metadata = validateBuild(metadata);
    this.path = join(directory, `skills-import-${randomUUID()}.sqlite`);
    this.db = new DatabaseSync(this.path);
    try {
      configure(this.db);
      createSchema(this.db);
    } catch (error) {
      this.dispose();
      throw error;
    }
  }
  dispose() {
    this.db?.close();
    this.db = undefined;
    this.complete = undefined;
    for (const suffix of ["", "-journal", "-wal", "-shm"]) {
      try {
        unlinkSync(this.path + suffix);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }
  private connection() {
    if (!this.db || this.complete) throw new Error("SDE import is closed");
    return this.db;
  }
  async import(entries: AsyncIterable<StaticDataEntry>) {
    const db = this.connection();
    db.exec(`CREATE TABLE raw_groups (id INTEGER PRIMARY KEY, category INTEGER NOT NULL) STRICT;
      CREATE TABLE raw_types (id INTEGER PRIMARY KEY, group_id INTEGER NOT NULL, name TEXT NOT NULL, published INTEGER NOT NULL) STRICT;
      CREATE TABLE raw_dogma (id INTEGER PRIMARY KEY, requirements TEXT, rank REAL) STRICT`);
    const seen = new Set<string>();
    for await (const entry of entries) {
      if (!STATIC_DATA_FILES.includes(entry.name)) continue;
      if (seen.has(entry.name)) throw new Error("Duplicate SDE archive entry");
      seen.add(entry.name);
      let count = 0;
      let batch: (() => void)[] = [];
      const flush = () => {
        transaction(db, () => {
          for (const insert of batch) {
            try {
              insert();
            } catch (error) {
              if (String(error).includes("UNIQUE constraint"))
                throw new Error("Duplicate SDE record ID", { cause: error });
              throw error;
            }
          }
          batch = [];
        });
      };
      for await (const row of entry.rows) {
        if (++count > 200_000)
          throw new Error("SDE record count exceeds limit");
        // Buffer only small decoded projections, never the raw JSONL/dogma objects.
        if (entry.name === "groups.jsonl") {
          const group = groupSchema.parse(row);
          batch.push(() => {
            db.prepare("INSERT INTO raw_groups VALUES (?, ?)").run(
              group._key,
              group.categoryID,
            );
          });
        } else if (entry.name === "types.jsonl") {
          const type = typeSchema.parse(row);
          batch.push(() => {
            db.prepare("INSERT INTO raw_types VALUES (?, ?, ?, ?)").run(
              type._key,
              type.groupID,
              type.name.en,
              Number(type.published),
            );
          });
        } else {
          const dogma = decodeDogma(row);
          batch.push(() => {
            db.prepare("INSERT INTO raw_dogma VALUES (?, ?, ?)").run(
              dogma.id,
              dogma.requirements === null
                ? null
                : JSON.stringify(dogma.requirements),
              dogma.rank,
            );
          });
        }
        if (batch.length === 256) flush();
      }
      if (batch.length) flush();
    }
    if (seen.size !== STATIC_DATA_FILES.length)
      throw new Error("SDE archive is missing required files");
    if (
      db
        .prepare(
          "SELECT 1 FROM raw_types t LEFT JOIN raw_groups g ON g.id = t.group_id WHERE g.id IS NULL LIMIT 1",
        )
        .get()
    )
      throw new Error("Missing SDE group");
    let after = -1;
    for (;;) {
      const rows = db
        .prepare(
          `SELECT t.id, ${boundedText("t.name", 8000)} AS name, t.group_id AS groupId,
        g.category AS categoryId, t.published, ${boundedText("d.requirements", 4096)} AS requirements, d.rank
        FROM raw_types t JOIN raw_groups g ON g.id = t.group_id LEFT JOIN raw_dogma d ON d.id = t.id
        WHERE t.id > ? AND g.category IN (6, 16) ORDER BY t.id LIMIT 256`,
        )
        .all(after);
      if (!rows.length) break;
      transaction(db, () => {
        for (const row of rows) {
          insertType(db, {
            ...row,
            published: row.published === 1,
            requirements:
              row.requirements === null
                ? null
                : JSON.parse(z.string().parse(row.requirements)),
          });
          after = typeId.parse(row.id);
        }
      });
    }
    db.exec(
      "DROP TABLE raw_groups; DROP TABLE raw_types; DROP TABLE raw_dogma",
    );
    return this.finish();
  }
  /** Exceptional bounded legacy/fixture input, not the archive import path. */
  fromCatalog(value: StaticCatalog) {
    const db = this.connection();
    const raw = JSON.stringify(value);
    if (Buffer.byteLength(raw) > MAX_CATALOG_BYTES)
      throw new Error("SDE cache exceeds byte limit");
    const catalog = validateCatalog(JSON.parse(raw));
    validateBuild(catalog);
    if (
      JSON.stringify(validateBuild(catalog)) !== JSON.stringify(this.metadata)
    )
      throw new Error("SDE archive metadata mismatch");
    transaction(db, () => {
      for (const type of catalog.types) insertType(db, type);
    });
    return this.finish();
  }
  private finish() {
    const db = this.connection();
    if (
      db
        .prepare(
          `SELECT 1 FROM skill_requirements r LEFT JOIN skill_types t ON t.id = r.skill_id WHERE t.id IS NULL OR t.category_id <> 16 LIMIT 1`,
        )
        .get()
    )
      throw new Error("Missing or non-skill prerequisite");
    const counts = db
      .prepare(
        "SELECT count(*) AS typeCount, coalesce(sum(category_id = 16 AND published = 1), 0) AS skillCount FROM skill_types",
      )
      .get();
    const metadata = metadataSchema.parse({ ...this.metadata, ...counts });
    const hash = createHash("sha256").update(
      JSON.stringify({ ...this.metadata, fetchedAt: null }),
    );
    // A bounded streaming digest over normalized, ordered row digests, independent of ZIP order.
    for (const row of db
      .prepare(
        `SELECT ${boundedText("sha256", 64)} AS sha256 FROM skill_types ORDER BY id`,
      )
      .iterate())
      hash.update(digestSchema.parse(row.sha256));
    this.complete = { metadata, sha256: hash.digest("hex") };
    db.close();
    this.db = undefined;
    return this;
  }
  result() {
    if (!this.complete) throw new Error("SDE import is incomplete");
    return this.complete;
  }
}

/** Publication/freshness only reads metadata; each consumer acquires its own snapshot. */
export class SkillStore {
  private readonly path: string;
  constructor(private readonly directory: string) {
    this.path = join(directory, "skills-v1.sqlite");
  }
  exists() {
    return exists(this.path);
  }
  private open(create = false) {
    const present = this.exists();
    if (!present && !create) throw new Error("SDE database is missing");
    const db = new DatabaseSync(this.path);
    try {
      configure(db);
      const version = db.prepare("PRAGMA user_version").get()?.user_version;
      if (!present && version === 0) {
        transaction(db, () => {
          if (db.prepare("PRAGMA user_version").get()?.user_version === 0) {
            if (
              db.prepare("PRAGMA application_id").get()?.application_id !== 0 ||
              db.prepare("SELECT 1 FROM sqlite_schema LIMIT 1").get()
            )
              throw new Error("Invalid SDE database schema");
            createSchema(db);
          } else checkSchema(db);
        });
      } else if (version === 1) {
        checkSchema(db, 1);
        transaction(db, () => {
          this.migrate(db);
        });
      }
      checkSchema(db);
      db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL");
      return db;
    } catch (error) {
      db.close();
      throw error;
    }
  }
  private migrate(db: DatabaseSync) {
    // The old blob is bounded/validated before any destructive schema statement.
    checkSchema(db, 1);
    const rows = db
      .prepare(
        `SELECT id, generation, ${boundedText("sha256", 64)} AS sha256,
      build_number AS buildNumber, ${boundedText("release_date", 64)} AS releaseDate,
      ${boundedText("source_url", 256)} AS sourceUrl, ${boundedText("fetched_at", 64)} AS fetchedAt,
      ${boundedText("checked_at", 64)} AS checkedAt, ${boundedText("etag", 4096)} AS etag,
      ${boundedText("catalog_json", MAX_CATALOG_BYTES)} AS catalogJson FROM skill_catalog LIMIT 2`,
      )
      .all();
    let legacy:
      | {
          catalog: StaticCatalog;
          generation: number;
          checkedAt: string;
          etag: string | null;
        }
      | undefined;
    if (rows.length) {
      const row = freshnessSchema
        .extend({
          id: z.literal(1),
          generation: typeId,
          sha256: digestSchema,
          catalogJson: z.string(),
          buildNumber: typeId,
          releaseDate: timestampSchema,
          sourceUrl: z.string().max(256),
          fetchedAt: timestampSchema,
        })
        .parse(rows[0]);
      if (rows.length !== 1 || digest(row.catalogJson) !== row.sha256)
        throw new Error("SDE cache checksum mismatch");
      const catalog = validateCatalog(JSON.parse(row.catalogJson));
      validateBuild(catalog);
      if (
        catalog.buildNumber !== row.buildNumber ||
        catalog.releaseDate !== row.releaseDate ||
        catalog.sourceUrl !== row.sourceUrl ||
        catalog.fetchedAt !== row.fetchedAt
      )
        throw new Error("SDE cache metadata mismatch");
      legacy = {
        catalog,
        generation: row.generation,
        checkedAt: row.checkedAt,
        etag: row.etag,
      };
    }
    db.exec("DROP TABLE skill_catalog");
    createSchema(db);
    if (legacy) {
      const stage = new SkillImport(this.directory, legacy.catalog);
      try {
        stage.fromCatalog(legacy.catalog);
        for (const type of legacy.catalog.types) insertType(db, type);
        writeSaved(db, {
          ...stage.result(),
          checkedAt: legacy.checkedAt,
          etag: legacy.etag,
          generation: legacy.generation,
        });
      } finally {
        stage.dispose();
      }
    }
  }
  read(): SavedSkills | undefined {
    if (!this.exists()) return undefined;
    const db = this.open();
    try {
      return readSaved(db);
    } finally {
      db.close();
    }
  }
  acquire() {
    const db = this.open();
    try {
      db.exec("PRAGMA query_only=ON; BEGIN");
      const saved = readSaved(db);
      if (!saved) throw new Error("SDE database is empty");
      // Reconcile cardinality in the same snapshot before a missing row can
      // silently turn an ambiguous name into a unique match.
      const counts = db
        .prepare(
          `SELECT
        (SELECT count(*) FROM skill_types) AS typeCount,
        (SELECT count(*) FROM skill_types WHERE published = 1 AND category_id = 16) AS skillCount`,
        )
        .get();
      if (
        counts?.typeCount !== saved.metadata.typeCount ||
        counts.skillCount !== saved.metadata.skillCount
      )
        throw new Error("SDE cache row count mismatch");
      const catalog = new SqlSkillReader(db, saved);
      return { catalog, saved, release: catalog.release };
    } catch (error) {
      db.close();
      throw error;
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
      const catalog = validateCatalog(saved.catalog);
      validateBuild(catalog);
      return { catalog, checkedAt: saved.checkedAt, etag: saved.etag };
    } finally {
      await file.close();
    }
  }
  publish(
    candidate: {
      catalog: SkillCatalog | StaticCatalog;
      checkedAt: string;
      etag: string | null;
    },
    onlyIfAbsent = false,
  ) {
    const data =
      "data" in candidate.catalog ? candidate.catalog.data : candidate.catalog;
    const stage = new SkillImport(this.directory, data);
    try {
      stage.fromCatalog(data);
      return this.publishImport(
        stage,
        candidate.checkedAt,
        candidate.etag,
        onlyIfAbsent,
      );
    } finally {
      stage.dispose();
    }
  }
  publishImport(
    stage: SkillImport,
    checkedAt: string,
    etag: string | null,
    onlyIfAbsent = false,
  ) {
    const freshness = freshnessSchema.parse({ checkedAt, etag });
    const candidate = stage.result();
    const present = this.exists();
    const db = this.open(true);
    try {
      const current = readSaved(db);
      if (onlyIfAbsent && !current && present)
        throw new Error("Legacy import requires an absent database");
      db.prepare("ATTACH DATABASE ? AS candidate").run(stage.path);
      return transaction(db, () => {
        checkSchema(db);
        const actual = readSaved(db);
        if (
          actual?.generation !== current?.generation ||
          actual?.sha256 !== current?.sha256
        )
          throw new Error("Concurrent SDE publication");
        if (
          current &&
          (onlyIfAbsent ||
            current.metadata.buildNumber >= candidate.metadata.buildNumber)
        ) {
          if (
            !onlyIfAbsent &&
            current.metadata.buildNumber === candidate.metadata.buildNumber &&
            current.sha256 !== candidate.sha256
          )
            throw new Error("Conflicting SDE build identity");
          return { saved: current, accepted: false };
        }
        const saved = savedSchema.parse({
          ...candidate,
          ...freshness,
          checkedAt: new Date(
            Math.max(
              Date.parse(checkedAt),
              current ? Date.parse(current.checkedAt) : -Infinity,
            ),
          ).toISOString(),
          generation: (current?.generation ?? 0) + 1,
        });
        db.exec(
          "DELETE FROM skill_requirements; DELETE FROM skill_types; INSERT INTO skill_types SELECT * FROM candidate.skill_types; INSERT INTO skill_requirements SELECT * FROM candidate.skill_requirements",
        );
        writeSaved(db, saved);
        return { saved, accepted: true };
      });
    } finally {
      db.close();
    }
  }
  check(expected: SavedSkills, checkedAt: string, etag: string | null) {
    const freshness = freshnessSchema.parse({ checkedAt, etag });
    const db = this.open();
    try {
      return transaction(db, () => {
        const current = readSaved(db);
        if (!current) throw new Error("SDE database is empty");
        if (
          current.generation !== expected.generation ||
          current.sha256 !== expected.sha256 ||
          Date.parse(checkedAt) < Date.parse(current.checkedAt)
        )
          return { saved: current, accepted: false };
        const saved = savedSchema.parse({
          ...current,
          ...freshness,
          generation: current.generation + 1,
        });
        writeSaved(db, saved);
        return { saved, accepted: true };
      });
    } finally {
      db.close();
    }
  }
}
