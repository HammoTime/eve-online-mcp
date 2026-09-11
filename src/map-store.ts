import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import * as z from "zod/v4";
import {
  MAP_DATA_LIMITS,
  MapCatalog,
  mapSourceSchema,
  validateMapData,
} from "../lib/src/cartography/catalog.js";
import {
  createPreparedMapScene,
  resolveMapBoundary,
  type MapSceneSource,
  type PreparedMapFacts,
  type PreparedMapScene,
} from "../lib/src/cartography/prepared.js";
import {
  enumerateMapReferences,
  parseMapRequest,
  type MapResolutionFact,
} from "../lib/src/cartography/references.js";
import {
  LIGHT_YEAR_METRES,
  MAP_LIMITS,
  MapError,
  type MapData,
  type MapRequest,
} from "../lib/src/cartography/types.js";

export const MAP_DATABASE_FILE = "maps-v1.sqlite";
const SCHEMA_VERSION = 1;
const APPLICATION_ID = 0x45564d50;
const MAX_CATALOG_BYTES = 64_000_000;
const digestSchema = z
  .string()
  .length(64)
  .regex(/^[a-f0-9]{64}$/);
const timestampSchema = z.string().max(64).pipe(z.iso.datetime());
const sourceSchema = mapSourceSchema.extend({
  releaseDate: timestampSchema,
  fetchedAt: timestampSchema,
  sourceUrl: z
    .string()
    .max(2048)
    .refine((value) => !value.includes("\0"))
    .pipe(z.url()),
});
const metadataSchema = z.object({
  checkedAt: timestampSchema,
  etag: z
    .string()
    .max(1024)
    .refine((value) => !value.includes("\0") && !/[\r\n]/.test(value))
    .nullable(),
  archiveSha256: digestSchema,
});
const snapshotSchema = metadataSchema
  .extend({
    source: sourceSchema.strict(),
  })
  .strict();

export interface MapSnapshot {
  source: MapSceneSource;
  checkedAt: string;
  etag: string | null;
  archiveSha256: string;
}

// A single active generation is replaced atomically. Compatibility JSON is kept
// separately so metadata and selected queries never fetch or parse the catalog.
const SCHEMA = [
  `CREATE TABLE active (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    snapshot TEXT NOT NULL CHECK (length(CAST(snapshot AS BLOB)) <= 8192),
    catalog_sha256 TEXT NOT NULL,
    content_sha256 TEXT NOT NULL
  ) STRICT`,
  `CREATE TABLE catalog (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    data TEXT NOT NULL CHECK (length(CAST(data AS BLOB)) <= ${MAX_CATALOG_BYTES})
  ) STRICT`,
  `CREATE TABLE entities (
    category TEXT NOT NULL CHECK (category IN ('system', 'region', 'constellation')),
    id INTEGER NOT NULL CHECK (id > 0),
    name TEXT NOT NULL,
    normalized_name TEXT NOT NULL,
    region_id INTEGER,
    PRIMARY KEY (category, id)
  ) STRICT, WITHOUT ROWID`,
  `CREATE INDEX entities_name ON entities (category, normalized_name, id)`,
  `CREATE TABLE systems (
    id INTEGER PRIMARY KEY CHECK (id > 0),
    region_id INTEGER NOT NULL,
    constellation_id INTEGER NOT NULL,
    x REAL NOT NULL, y REAL NOT NULL, z REAL NOT NULL,
    x_ly REAL NOT NULL, z_ly REAL NOT NULL,
    map_x REAL, map_y REAL,
    security_status REAL NOT NULL,
    outgoing_gate_count INTEGER NOT NULL CHECK (outgoing_gate_count >= 0),
    incoming_gate_count INTEGER NOT NULL CHECK (incoming_gate_count >= 0),
    CHECK ((map_x IS NULL) = (map_y IS NULL))
  ) STRICT`,
  `CREATE INDEX systems_region ON systems (region_id, id)`,
  `CREATE INDEX systems_constellation ON systems (constellation_id, id)`,
  `CREATE INDEX systems_extent ON systems (x_ly, z_ly, id)`,
  `CREATE TABLE connections (
    from_id INTEGER NOT NULL REFERENCES systems(id),
    to_id INTEGER NOT NULL REFERENCES systems(id),
    forward_count INTEGER NOT NULL CHECK (forward_count >= 0),
    reverse_count INTEGER NOT NULL CHECK (reverse_count >= 0),
    PRIMARY KEY (from_id, to_id),
    CHECK (from_id < to_id AND forward_count + reverse_count > 0)
  ) STRICT, WITHOUT ROWID`,
  `CREATE INDEX connections_to ON connections (to_id, from_id)`,
];
const normalizeSql = (sql: string) => sql.replace(/\s+/g, " ").trim();
const schemaSql = SCHEMA.map(normalizeSql).sort();

// Guard inside SQLite, before Node 22.13 can truncate TEXT at NUL or allocate an
// unbounded result string. Only fixed, internal column expressions reach here.
function safeText(column: string, maxBytes: number): string {
  return `CASE WHEN typeof(${column}) = 'text'
    AND length(CAST(${column} AS BLOB)) BETWEEN 1 AND ${maxBytes}
    THEN CASE WHEN instr(CAST(${column} AS BLOB), x'00') = 0 THEN ${column} END END`;
}
function safeName(alias: string): string {
  return `CASE WHEN ${safeText(`${alias}.name`, 400)} IS NOT NULL
    AND ${safeText(`${alias}.normalized_name`, 800)} IS NOT NULL
    THEN CASE WHEN length(${alias}.normalized_name) <= 200 AND length(${alias}.name) <= 100
      THEN ${alias}.name END END`;
}

function invalid(message: string): never {
  throw new MapError("MAP_DATA_INVALID", message);
}
function unavailable(): never {
  throw new MapError(
    "MAP_DATA_UNAVAILABLE",
    "No local map snapshot is available.",
  );
}
function checksum(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
function decode(value: unknown): unknown {
  if (typeof value !== "string") invalid("Invalid local map JSON storage.");
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return invalid("Corrupt local map JSON storage.");
  }
}
function verifySchema(db: DatabaseSync): void {
  const version = db.prepare("PRAGMA user_version").get()?.user_version;
  const application = db.prepare("PRAGMA application_id").get()?.application_id;
  const actual = db
    .prepare(
      `SELECT ${safeText("sql", 8192)} AS sql,
      CASE WHEN ${safeText("name", 128)} IS NOT NULL
        AND ${safeText("tbl_name", 128)} IS NOT NULL
        AND ${safeText("type", 16)} IS NOT NULL THEN 1 ELSE 0 END AS valid
      FROM sqlite_schema
      LIMIT ${SCHEMA.length + 1}`,
    )
    .all()
    .map((row) =>
      row.valid === 1 && typeof row.sql === "string"
        ? normalizeSql(row.sql)
        : "",
    )
    .sort();
  if (
    version !== SCHEMA_VERSION ||
    application !== APPLICATION_ID ||
    actual.length !== schemaSql.length ||
    actual.some((sql, index) => sql !== schemaSql[index])
  )
    invalid(
      "Unsupported or corrupt local map database schema; no recovery was attempted.",
    );
}
function active(db: DatabaseSync) {
  const row = db
    .prepare(
      `SELECT
    ${safeText("snapshot", 8192)} AS snapshot,
    ${safeText("catalog_sha256", 64)} AS catalog_sha256,
    ${safeText("content_sha256", 64)} AS content_sha256 FROM active WHERE id = 1`,
    )
    .get();
  if (!row) {
    const occupied = db
      .prepare(
        `SELECT
      EXISTS (SELECT 1 FROM catalog) OR EXISTS (SELECT 1 FROM entities) OR
      EXISTS (SELECT 1 FROM systems) OR EXISTS (SELECT 1 FROM connections) AS occupied`,
      )
      .get();
    if (occupied?.occupied)
      invalid("Local map projection has no active snapshot.");
    return undefined;
  }
  const parsed = snapshotSchema.safeParse(decode(row.snapshot));
  if (
    !parsed.success ||
    !digestSchema.safeParse(row.catalog_sha256).success ||
    !digestSchema.safeParse(row.content_sha256).success
  )
    invalid("Invalid local map snapshot metadata.");
  return {
    snapshot: parsed.data,
    catalogSha256: row.catalog_sha256 as string,
    contentSha256: row.content_sha256 as string,
  };
}
function updateCheck(
  db: DatabaseSync,
  current: MapSnapshot,
  checkedAt: string,
  etag: string | null,
): MapSnapshot {
  if (Date.parse(checkedAt) <= Date.parse(current.checkedAt)) return current;
  const snapshot = { ...current, checkedAt, etag };
  db.prepare("UPDATE active SET snapshot = ? WHERE id = 1").run(
    JSON.stringify(snapshot),
  );
  return snapshot;
}

const RESOLUTIONS_SQL = `WITH queries AS MATERIALIZED (
  SELECT value ->> '$.key' AS key, value ->> '$.category' AS category,
    value ->> '$.reference' AS reference, json_type(value, '$.reference') AS kind
  FROM json_each(?)
), matches AS (
  SELECT q.key, e.id, ${safeName("e")} AS name FROM queries q CROSS JOIN entities e
    ON e.category = q.category AND e.id = q.reference WHERE q.kind = 'integer'
  UNION ALL
  SELECT q.key, e.id, ${safeName("e")} AS name FROM queries q CROSS JOIN entities e INDEXED BY entities_name
    ON e.category = q.category AND e.normalized_name = q.reference WHERE q.kind = 'text'
), ranked AS (
  SELECT *, count(*) OVER (PARTITION BY key) AS candidate_count,
    max(name IS NULL) OVER (PARTITION BY key) AS invalid_name,
    row_number() OVER (PARTITION BY key ORDER BY id) AS rank FROM matches
)
SELECT CASE WHEN coalesce(max(r.invalid_name), 0) = 0 THEN
  json_object('key', q.key, 'candidateCount', coalesce(max(r.candidate_count), 0),
  'candidates', json_group_array(json_object('id', r.id, 'name', r.name) ORDER BY r.id)
    FILTER (WHERE r.id IS NOT NULL)) END AS fact
FROM queries q LEFT JOIN ranked r ON r.key = q.key AND r.rank <= 10 GROUP BY q.key`;

const SYSTEMS_SQL = `WITH selected AS (SELECT value AS id FROM json_each(?))
SELECT s.*, ${safeName("e")} AS name, ${safeName("r")} AS region_name,
  ${safeName("c")} AS constellation_name
FROM selected q CROSS JOIN systems s ON s.id = q.id
CROSS JOIN entities e ON e.category = 'system' AND e.id = s.id
CROSS JOIN entities r ON r.category = 'region' AND r.id = s.region_id
CROSS JOIN entities c ON c.category = 'constellation' AND c.id = s.constellation_id
  AND c.region_id = s.region_id
ORDER BY s.id`;

// Incident rows also prove complete incoming/outgoing degrees for each selected
// endpoint. Only the final drawing/boundary aggregation deduplicates pairs.
const CONNECTIONS_SQL = `WITH selected AS MATERIALIZED (SELECT value AS id FROM json_each(?)),
incident AS MATERIALIZED (
  SELECT c.*, s.id, c.forward_count AS outgoing, c.reverse_count AS incoming,
    c.to_id IN (SELECT id FROM selected) AS internal
  FROM selected s CROSS JOIN connections c ON c.from_id = s.id
  UNION ALL
  SELECT c.*, s.id, c.reverse_count AS outgoing, c.forward_count AS incoming,
    c.from_id IN (SELECT id FROM selected) AS internal
  FROM selected s CROSS JOIN connections c INDEXED BY connections_to ON c.to_id = s.id
), degrees AS (
  SELECT id, sum(outgoing) AS outgoing, sum(incoming) AS incoming FROM incident GROUP BY id
), touching AS (
  SELECT * FROM incident WHERE id = from_id OR from_id NOT IN (SELECT id FROM selected)
)
SELECT json_group_array(json_object('from', from_id, 'to', to_id,
  'directionMask', (CASE WHEN forward_count > 0 THEN 1 ELSE 0 END) |
    (CASE WHEN reverse_count > 0 THEN 2 ELSE 0 END),
  'forwardGateCount', forward_count, 'reverseGateCount', reverse_count)
  ORDER BY from_id, to_id) FILTER (WHERE internal) AS pairs,
  coalesce(sum(CASE WHEN internal THEN 0 ELSE 1 END), 0) AS boundary_connections,
  (SELECT count(*) FROM selected q CROSS JOIN systems s ON s.id = q.id
    LEFT JOIN degrees d ON d.id = s.id
    WHERE s.incoming_gate_count NOT BETWEEN 0 AND ${MAP_DATA_LIMITS.gates}
      OR s.outgoing_gate_count != coalesce(d.outgoing, 0)
      OR s.incoming_gate_count != coalesce(d.incoming, 0)) AS invalid_degrees
FROM touching`;

/** Synchronous public map projection; no connection or full catalog is retained. */
export class LocalMapStore {
  private readonly path: string;

  constructor(private readonly directory: string) {
    this.path = join(directory, MAP_DATABASE_FILE);
  }

  private transaction<T>(
    mode: "read" | "publish" | "touch",
    operation: (db: DatabaseSync) => T,
    signal?: AbortSignal,
  ): T | undefined {
    signal?.throwIfAborted();
    const exists = existsSync(this.path);
    if (!exists && mode !== "publish") return undefined;
    if (!exists) mkdirSync(this.directory, { recursive: true });
    const db = new DatabaseSync(this.path, { readOnly: mode === "read" });
    try {
      // The constructor timeout option is not available in Node 22.13.
      db.exec(
        "PRAGMA busy_timeout = 5000; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON; PRAGMA trusted_schema = OFF",
      );
      if (mode !== "read") {
        db.exec("BEGIN IMMEDIATE");
        try {
          if (
            !exists &&
            db.prepare("PRAGMA user_version").get()?.user_version === 0 &&
            !db.prepare("SELECT 1 FROM sqlite_schema LIMIT 1").get()
          ) {
            for (const sql of SCHEMA) db.exec(sql);
            db.exec(
              `PRAGMA user_version = ${SCHEMA_VERSION}; PRAGMA application_id = ${APPLICATION_ID}`,
            );
          } else verifySchema(db);
          db.exec("COMMIT");
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
        db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL");
      } else db.exec("PRAGMA query_only = ON");
      db.exec(mode === "read" ? "BEGIN" : "BEGIN IMMEDIATE");
      try {
        verifySchema(db);
        const result = operation(db);
        signal?.throwIfAborted();
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    } finally {
      db.close();
    }
  }

  read(): MapSnapshot | undefined {
    return this.transaction("read", (db) => active(db)?.snapshot);
  }

  publish(
    catalog: MapCatalog,
    metadata: { checkedAt: string; etag: string | null; archiveSha256: string },
  ): MapSnapshot {
    // Revalidate mutable catalog.data, not its potentially stale in-memory indexes.
    const data = validateMapData(catalog.data);
    const parsed = metadataSchema.safeParse(metadata);
    if (!parsed.success) invalid("Invalid local map publication metadata.");
    const text = JSON.stringify(data);
    if (Buffer.byteLength(text) > MAX_CATALOG_BYTES)
      throw new MapError(
        "MAP_DATA_LIMIT",
        "Local map catalog exceeds byte limit.",
      );
    const catalogSha256 = checksum(text);
    // Independent downloads of the same build may have different fetch times.
    const contentSha256 = checksum(JSON.stringify({ ...data, fetchedAt: "" }));
    const parsedSource = sourceSchema.safeParse(data);
    if (!parsedSource.success) invalid("Invalid local map source metadata.");
    const source = parsedSource.data;
    const snapshot: MapSnapshot = { source, ...parsed.data };
    return (
      this.transaction("publish", (db) => {
        const current = active(db);
        if (current && current.snapshot.source.buildNumber > source.buildNumber)
          return current.snapshot;
        if (current?.snapshot.source.buildNumber === source.buildNumber) {
          if (
            current.contentSha256 !== contentSha256 ||
            current.snapshot.archiveSha256 !== snapshot.archiveSha256 ||
            current.snapshot.source.releaseDate !== source.releaseDate ||
            current.snapshot.source.sourceUrl !== source.sourceUrl
          )
            invalid("Conflicting identity or digest for the active map build.");
          // An independent same-build download does not fence its manifest check.
          // Only touch() may advance freshness from an observed current snapshot.
          return current.snapshot;
        }
        db.exec(
          "DELETE FROM catalog; DELETE FROM connections; DELETE FROM systems; DELETE FROM entities; DELETE FROM active",
        );
        // Name normalization is deliberately JavaScript's Unicode trim/lowercase,
        // not SQLite lower()/NOCASE (which only fold ASCII by default).
        const entities = [
          ...data.regions.map((item) => ({ ...item, category: "region" })),
          ...data.constellations.map((item) => ({
            ...item,
            category: "constellation",
          })),
          ...data.systems.map(({ id, name }) => ({
            id,
            name,
            category: "system",
          })),
        ].map((item) => ({
          ...item,
          normalizedName: item.name.trim().toLowerCase(),
        }));
        db.prepare(
          `INSERT INTO entities
        SELECT value ->> '$.category', value ->> '$.id', value ->> '$.name',
          value ->> '$.normalizedName', value ->> '$.regionId' FROM json_each(?)`,
        ).run(JSON.stringify(entities));
        db.prepare(
          `WITH gates AS MATERIALIZED (
        SELECT value ->> '$.systemId' AS origin, value ->> '$.destinationId' AS destination
        FROM json_each(?, '$.gates')
      ), incident AS (
        SELECT origin AS id, 1 AS outgoing, 0 AS incoming FROM gates
        UNION ALL SELECT destination AS id, 0 AS outgoing, 1 AS incoming FROM gates
      ), degrees AS (
        SELECT id, sum(outgoing) AS outgoing, sum(incoming) AS incoming FROM incident GROUP BY id
      ) INSERT INTO systems
      SELECT s.value ->> '$.id', s.value ->> '$.regionId', s.value ->> '$.constellationId',
        s.value ->> '$.position.x', s.value ->> '$.position.y', s.value ->> '$.position.z',
        (s.value ->> '$.position.x') * 1.0 / ?, (s.value ->> '$.position.z') * 1.0 / ?,
        s.value ->> '$.position2D.x', s.value ->> '$.position2D.y',
        s.value ->> '$.securityStatus', coalesce(d.outgoing, 0), coalesce(d.incoming, 0)
      FROM json_each(?, '$.systems') s LEFT JOIN degrees d ON d.id = s.value ->> '$.id'`,
        ).run(text, LIGHT_YEAR_METRES, LIGHT_YEAR_METRES, text);
        db.prepare(
          `WITH gates AS (
        SELECT value ->> '$.systemId' AS origin, value ->> '$.destinationId' AS destination
        FROM json_each(?, '$.gates')
      ) INSERT INTO connections SELECT min(origin, destination), max(origin, destination),
        sum(CASE WHEN origin < destination THEN 1 ELSE 0 END),
        sum(CASE WHEN origin > destination THEN 1 ELSE 0 END)
      FROM gates GROUP BY min(origin, destination), max(origin, destination)`,
        ).run(text);
        db.prepare("INSERT INTO catalog VALUES (1, ?)").run(text);
        db.prepare("INSERT INTO active VALUES (1, ?, ?, ?)").run(
          JSON.stringify(snapshot),
          catalogSha256,
          contentSha256,
        );
        return snapshot;
      }) ?? unavailable()
    );
  }

  touch(
    expected: MapSnapshot,
    checkedAt: string,
    etag: string | null,
  ): MapSnapshot {
    const parsed = snapshotSchema.safeParse(expected);
    const metadata = metadataSchema.safeParse({
      checkedAt,
      etag,
      archiveSha256: expected.archiveSha256,
    });
    if (!parsed.success || !metadata.success)
      invalid("Invalid local map check metadata.");
    return (
      this.transaction("touch", (db) => {
        const current = active(db)?.snapshot ?? unavailable();
        if (
          current.source.buildNumber !== parsed.data.source.buildNumber ||
          current.archiveSha256 !== parsed.data.archiveSha256 ||
          current.source.releaseDate !== parsed.data.source.releaseDate ||
          current.source.sourceUrl !== parsed.data.source.sourceUrl ||
          current.source.fetchedAt !== parsed.data.source.fetchedAt ||
          current.checkedAt !== parsed.data.checkedAt ||
          current.etag !== parsed.data.etag
        )
          return current;
        return updateCheck(db, current, checkedAt, etag);
      }) ?? unavailable()
    );
  }

  prepare(
    request: MapRequest,
    signal?: AbortSignal,
  ): { scene: PreparedMapScene; snapshot: MapSnapshot } {
    signal?.throwIfAborted();
    const input = parseMapRequest(request);
    return (
      this.transaction(
        "read",
        (db) => {
          const snapshot = active(db)?.snapshot ?? unavailable();
          const resolutions = db
            .prepare(RESOLUTIONS_SQL)
            .all(JSON.stringify(enumerateMapReferences(input)))
            .map((row) => decode(row.fact) as MapResolutionFact);
          const boundary = resolveMapBoundary(input, resolutions);
          let selection: string;
          let parameters: SQLInputValue[];
          switch (boundary.kind) {
            case "systems":
              selection =
                "SELECT s.id FROM json_each(?) q CROSS JOIN systems s ON s.id = q.value";
              parameters = [JSON.stringify(boundary.systemIds)];
              break;
            case "region":
              selection =
                "SELECT id FROM systems INDEXED BY systems_region WHERE region_id = ?";
              parameters = [boundary.regionId];
              break;
            case "constellation":
              selection =
                "SELECT id FROM systems INDEXED BY systems_constellation WHERE constellation_id = ?";
              parameters = [boundary.constellationId];
              break;
            case "extent":
              selection =
                "SELECT id FROM systems INDEXED BY systems_extent WHERE x_ly BETWEEN ? AND ? AND z_ly BETWEEN ? AND ?";
              parameters = [
                boundary.minX,
                boundary.maxX,
                boundary.minZ,
                boundary.maxZ,
              ];
              break;
            case "neighborhood":
              selection = `SELECT ? AS id UNION SELECT to_id FROM connections WHERE from_id = ?
            UNION SELECT from_id FROM connections INDEXED BY connections_to WHERE to_id = ?`;
              parameters = [
                boundary.centerId,
                boundary.centerId,
                boundary.centerId,
              ];
              break;
          }
          const systemCount = db
            .prepare(`SELECT count(*) AS count FROM (${selection})`)
            .get(...parameters)?.count as number;
          const facts: PreparedMapFacts = {
            source: snapshot.source,
            resolutions,
            systemCount,
            systems: [],
            internalPairs: [],
            boundaryConnections: 0,
          };
          if (systemCount > 0 && systemCount <= MAP_LIMITS.systems) {
            const ids = JSON.stringify(
              db
                .prepare(selection)
                .all(...parameters)
                .map((row) => row.id),
            );
            // Read REAL columns directly: SQLite JSON serialization can round doubles.
            facts.systems = db
              .prepare(SYSTEMS_SQL)
              .all(ids)
              .map(
                (row) =>
                  ({
                    id: row.id,
                    name: row.name,
                    regionId: row.region_id,
                    constellationId: row.constellation_id,
                    position: { x: row.x, y: row.y, z: row.z },
                    ...(row.map_x === null && row.map_y === null
                      ? {}
                      : {
                          position2D: { x: row.map_x, y: row.map_y },
                        }),
                    securityStatus: row.security_status,
                    regionName: row.region_name,
                    constellationName: row.constellation_name,
                    outgoingGateCount: row.outgoing_gate_count,
                  }) as PreparedMapFacts["systems"][number],
              );
            const connections = db.prepare(CONNECTIONS_SQL).get(ids);
            if (connections?.invalid_degrees !== 0)
              invalid(
                "Local map connection degrees do not match the complete stored projection.",
              );
            facts.internalPairs = decode(
              connections.pairs,
            ) as PreparedMapFacts["internalPairs"];
            facts.boundaryConnections =
              connections.boundary_connections as number;
          }
          return { scene: createPreparedMapScene(input, facts), snapshot };
        },
        signal,
      ) ?? unavailable()
    );
  }

  /** Compatibility only: initialization/scripts, never the normal prepare path. */
  loadCatalog(): { catalog: MapCatalog; snapshot: MapSnapshot } {
    return (
      this.transaction("read", (db) => {
        const current = active(db) ?? unavailable();
        const row = db
          .prepare(
            `SELECT ${safeText("data", MAX_CATALOG_BYTES)} AS data
        FROM catalog WHERE id = 1`,
          )
          .get();
        if (
          typeof row?.data !== "string" ||
          checksum(row.data) !== current.catalogSha256
        )
          invalid(
            "Missing, oversized or corrupt local map compatibility catalog.",
          );
        const catalog = new MapCatalog(decode(row.data) as MapData);
        const parsedSource = sourceSchema.safeParse(catalog.data);
        if (!parsedSource.success)
          invalid("Invalid local map source metadata.");
        const source = parsedSource.data;
        if (
          JSON.stringify(source) !== JSON.stringify(current.snapshot.source) ||
          checksum(JSON.stringify({ ...catalog.data, fetchedAt: "" })) !==
            current.contentSha256
        )
          invalid("Local map catalog does not match the active snapshot.");
        return { catalog, snapshot: current.snapshot };
      }) ?? unavailable()
    );
  }
}
