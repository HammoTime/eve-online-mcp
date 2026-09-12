import { createHash, randomUUID } from "node:crypto";
import {
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import * as z from "zod/v4";

const DIRECTORY = "sde-archives-v1";
const DATABASE = "index.sqlite";
const MAX_BYTES = 256_000_000;
const TIMEOUT_MS = 180_000;
const APPLICATION_ID = 0x45565341;
const buildSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const releaseSchema = z.string().max(64).pipe(z.iso.datetime());
const rowSchema = z.strictObject({
  slot: z.union([z.literal(0), z.literal(1)]),
  token: z.uuid(),
  build: buildSchema,
  release: releaseSchema,
  limit_bytes: z.number().int().min(1).max(MAX_BYTES),
  size: z.number().int().min(0).max(MAX_BYTES),
  sha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
  readers: z.number().int().min(0).max(1024),
});
type Row = z.infer<typeof rowSchema>;
const SCHEMA = `CREATE TABLE archives (
  slot INTEGER PRIMARY KEY CHECK (slot IN (0, 1)),
  token TEXT NOT NULL,
  build INTEGER NOT NULL,
  release TEXT NOT NULL,
  limit_bytes INTEGER NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT,
  readers INTEGER NOT NULL
) STRICT`;

export interface SdeArchiveOptions {
  directory: string;
  source: { buildNumber: number; releaseDate: string; sourceUrl: string };
  fetchImplementation: typeof fetch;
  userAgent: string;
  maxArchiveBytes: number;
  now?: () => number;
}

function unavailable(): Error {
  return new Error(
    "Shared SDE archive is unavailable: download, validation or bounded cache reservation failed.",
  );
}

function archivePath(directory: string, slot: number): string {
  return join(directory, `archive-${slot}.zip`);
}

function regularFile(path: string, maxBytes: number): number {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > maxBytes)
    throw unavailable();
  return stat.size;
}

// No lease expiry authorizes reuse. Persisted reservations/readers survive crashes;
// uncertain owners consume one of two slots instead of risking a live reader/writer.
function transaction<T>(
  directory: string,
  operation: (db: DatabaseSync, rows: Row[]) => T,
): T {
  const path = join(directory, DATABASE);
  if (!lstatSync(directory).isDirectory() || regularFile(path, 65_536) === 0)
    throw unavailable();
  const db = new DatabaseSync(path);
  try {
    db.exec(
      "PRAGMA busy_timeout = 1000; PRAGMA trusted_schema = OFF; PRAGMA synchronous = FULL; PRAGMA max_page_count = 16",
    );
    db.exec("BEGIN IMMEDIATE");
    try {
      const schema = db
        .prepare(
          "SELECT CASE WHEN length(CAST(sql AS BLOB)) <= 2048 AND instr(CAST(sql AS BLOB), x'00') = 0 THEN sql END AS sql FROM sqlite_schema LIMIT 2",
        )
        .all();
      if (
        db.prepare("PRAGMA user_version").get()?.user_version !== 1 ||
        db.prepare("PRAGMA application_id").get()?.application_id !==
          APPLICATION_ID ||
        db.prepare("PRAGMA journal_mode").get()?.journal_mode !== "delete" ||
        db.prepare("PRAGMA page_size").get()?.page_size !== 4096 ||
        schema.length !== 1 ||
        schema[0]?.sql !== SCHEMA
      )
        throw unavailable();
      const rows = db
        .prepare(
          `SELECT slot, build, limit_bytes, size, readers,
        CASE WHEN length(CAST(token AS BLOB)) = 36 AND instr(CAST(token AS BLOB), x'00') = 0 THEN token END AS token,
        CASE WHEN length(CAST(release AS BLOB)) BETWEEN 1 AND 64 AND instr(CAST(release AS BLOB), x'00') = 0 THEN release END AS release,
        CASE WHEN sha256 IS NULL OR (length(CAST(sha256 AS BLOB)) = 64 AND instr(CAST(sha256 AS BLOB), x'00') = 0) THEN sha256 ELSE '' END AS sha256
        FROM archives LIMIT 3`,
        )
        .all()
        .map((row) => rowSchema.parse(row));
      if (
        rows.length > 2 ||
        new Set(rows.map((row) => row.build)).size !== rows.length
      )
        throw unavailable();
      for (const row of rows) {
        if (row.sha256 === null) {
          if (row.size !== 0 || row.readers !== 0) throw unavailable();
        } else if (
          row.size < 1 ||
          row.size > row.limit_bytes ||
          regularFile(archivePath(directory, row.slot), row.limit_bytes) !==
            row.size
        ) {
          throw unavailable();
        }
      }
      // A file with no reservation is not ours to overwrite or remove.
      for (const slot of [0, 1]) {
        if (
          !rows.some((row) => row.slot === slot) &&
          existsSync(archivePath(directory, slot))
        )
          throw unavailable();
      }
      const result = operation(db, rows);
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

function prune(directory: string, db: DatabaseSync, rows: Row[]): void {
  const newest = Math.max(
    ...rows.filter((row) => row.sha256 !== null).map((row) => row.build),
  );
  for (const row of rows) {
    if (row.sha256 !== null && row.build < newest && row.readers === 0) {
      // Deletion and reservation reuse share a transaction. A crash between the
      // unlink and commit leaves a missing-file record and fails closed.
      unlinkSync(archivePath(directory, row.slot));
      db.prepare("DELETE FROM archives WHERE slot = ? AND token = ?").run(
        row.slot,
        row.token,
      );
    }
  }
}

async function initialize(
  directory: string,
  signal: AbortSignal,
): Promise<void> {
  if (existsSync(directory)) return;
  const staging = `${directory}.init`;
  try {
    mkdirSync(staging, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    while (!existsSync(directory)) await delay(50, undefined, { signal });
    return;
  }
  // One fixed initialization reservation, never an accumulating set of temp dirs.
  const db = new DatabaseSync(join(staging, DATABASE));
  try {
    db.exec(
      "PRAGMA page_size = 4096; PRAGMA max_page_count = 16; PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL; BEGIN IMMEDIATE",
    );
    db.exec(SCHEMA);
    db.exec(
      `PRAGMA user_version = 1; PRAGMA application_id = ${APPLICATION_ID}; COMMIT`,
    );
  } finally {
    db.close();
  }
  if (existsSync(directory)) throw unavailable();
  renameSync(staging, directory);
}

function interrupt<T>(
  pending: Promise<T>,
  signal: AbortSignal,
  late?: (value: T) => void,
): Promise<T> {
  return new Promise((resolve, reject) => {
    let aborted = signal.aborted;
    const abort = () => {
      aborted = true;
      reject(unavailable());
    };
    if (aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    void pending
      .then(
        (value) => {
          signal.removeEventListener("abort", abort);
          if (aborted) late?.(value);
          else resolve(value);
        },
        () => {
          signal.removeEventListener("abort", abort);
          reject(unavailable());
        },
      )
      .catch(() => undefined);
  });
}

async function download(
  options: SdeArchiveOptions,
  path: string,
  signal: AbortSignal,
  spool: { closed: boolean },
): Promise<{ size: number; sha256: string }> {
  const response = await interrupt(
    options.fetchImplementation(options.source.sourceUrl, {
      headers: { "User-Agent": options.userAgent },
      redirect: "error",
      signal,
    }),
    signal,
    (late) => {
      void late.body?.cancel().catch(() => undefined);
    },
  );
  const body = response.body;
  const length = response.headers.get("content-length");
  if (
    !response.ok ||
    !body ||
    (length !== null &&
      (!/^\d+$/.test(length) || Number(length) > options.maxArchiveBytes))
  ) {
    void body?.cancel().catch(() => undefined);
    throw unavailable();
  }
  const reader = body.getReader();
  try {
    const file = await open(path, "wx", 0o600);
    spool.closed = false;
    try {
      const hash = createHash("sha256");
      let size = 0;
      for (;;) {
        const part = await interrupt(reader.read(), signal);
        signal.throwIfAborted();
        if (part.done) break;
        if (part.value.byteLength > options.maxArchiveBytes - size)
          throw unavailable();
        size += part.value.byteLength;
        hash.update(part.value);
        await file.writeFile(part.value);
      }
      if (!size) throw unavailable();
      await file.sync();
      return { size, sha256: hash.digest("hex") };
    } finally {
      await file.close();
      spool.closed = true;
    }
  } finally {
    // Some injected transports ignore abort or never settle cancellation. Neither
    // their late rejections nor pending body reads can retain an open spool file.
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/** Retains the newest complete, hashed public CCP ZIP; the path is valid only
 * during consume. Callbacks must close their own archive handles before settling.
 * now is accepted for adapter clock injection, never for reclaiming ownership. */
export async function withSdeArchive<T>(
  options: SdeArchiveOptions,
  consume: (archivePath: string, archiveSha256: string) => Promise<T>,
): Promise<T> {
  let release: (() => void) | undefined;
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, TIMEOUT_MS);
  timeout.unref();
  try {
    const build = buildSchema.parse(options.source.buildNumber);
    const date = releaseSchema.parse(options.source.releaseDate);
    const url = `https://developers.eveonline.com/static-data/tranquility/eve-online-static-data-${build}-jsonl.zip`;
    if (
      options.source.sourceUrl !== url ||
      !Number.isSafeInteger(options.maxArchiveBytes) ||
      options.maxArchiveBytes < 1 ||
      options.maxArchiveBytes > MAX_BYTES ||
      typeof options.userAgent !== "string" ||
      options.userAgent.length > 1024 ||
      /[\r\n\0]/.test(options.userAgent)
    )
      throw unavailable();
    // Snapshot caller-owned fields before awaiting; only this fixed URL is fetched.
    options = {
      ...options,
      source: { buildNumber: build, releaseDate: date, sourceUrl: url },
    };
    mkdirSync(options.directory, { recursive: true });
    const directory = join(options.directory, DIRECTORY);
    const signal = controller.signal;
    await initialize(directory, signal);
    let selected: { row: Row; download: boolean } | undefined;
    while (!selected) {
      signal.throwIfAborted();
      selected = transaction(directory, (db, rows) => {
        const existing = rows.find((row) => row.build === build);
        if (existing) {
          if (existing.release !== date) throw unavailable();
          if (existing.sha256 === null) return undefined;
          if (
            existing.size > options.maxArchiveBytes ||
            existing.readers === 1024
          )
            throw unavailable();
          db.prepare(
            "UPDATE archives SET readers = readers + 1 WHERE slot = ? AND token = ?",
          ).run(existing.slot, existing.token);
          return { row: existing, download: false };
        }
        if (rows.some((row) => row.sha256 !== null && row.build > build))
          throw unavailable();
        const slot = [0, 1].find(
          (candidate) => !rows.some((row) => row.slot === candidate),
        );
        if (slot === undefined) throw unavailable();
        const row: Row = {
          slot: slot as 0 | 1,
          token: randomUUID(),
          build,
          release: date,
          limit_bytes: options.maxArchiveBytes,
          size: 0,
          sha256: null,
          readers: 0,
        };
        db.prepare(
          "INSERT INTO archives VALUES (?, ?, ?, ?, ?, 0, NULL, 0)",
        ).run(row.slot, row.token, build, date, row.limit_bytes);
        return { row, download: true };
      });
      if (!selected) await delay(50, undefined, { signal });
    }
    const { row } = selected;
    const path = archivePath(directory, row.slot);
    if (selected.download) {
      const spool = { closed: true };
      try {
        const complete = await download(options, path, signal, spool);
        signal.throwIfAborted();
        transaction(directory, (db, rows) => {
          const owned = rows.find(
            (current) =>
              current.slot === row.slot &&
              current.token === row.token &&
              current.sha256 === null,
          );
          if (!owned) throw unavailable();
          db.prepare(
            "UPDATE archives SET size = ?, sha256 = ?, readers = 1 WHERE slot = ? AND token = ?",
          ).run(complete.size, complete.sha256, row.slot, row.token);
          Object.assign(owned, complete, { readers: 1 });
          prune(directory, db, rows);
        });
        Object.assign(row, complete);
      } catch (error) {
        if (!spool.closed) throw unavailable();
        transaction(directory, (db, rows) => {
          if (
            !rows.some(
              (current) =>
                current.slot === row.slot &&
                current.token === row.token &&
                current.sha256 === null,
            )
          )
            throw unavailable();
          if (existsSync(path)) {
            regularFile(path, row.limit_bytes);
            unlinkSync(path);
          }
          db.prepare("DELETE FROM archives WHERE slot = ? AND token = ?").run(
            row.slot,
            row.token,
          );
        });
        throw error;
      }
    }
    release = () => {
      transaction(directory, (db, rows) => {
        const owned = rows.find(
          (current) =>
            current.slot === row.slot &&
            current.token === row.token &&
            current.readers > 0 &&
            current.sha256 === row.sha256,
        );
        if (!owned) throw unavailable();
        db.prepare(
          "UPDATE archives SET readers = readers - 1 WHERE slot = ? AND token = ?",
        ).run(row.slot, row.token);
        owned.readers--;
        prune(directory, db, rows);
      });
    };
    if (!selected.download) {
      const hash = createHash("sha256");
      let size = 0;
      for await (const chunk of createReadStream(path, { signal })) {
        const bytes = chunk as Buffer;
        if (bytes.byteLength > options.maxArchiveBytes - size)
          throw unavailable();
        size += bytes.byteLength;
        hash.update(bytes);
      }
      if (size !== row.size || hash.digest("hex") !== row.sha256)
        throw unavailable();
    }
    signal.throwIfAborted();
    clearTimeout(timeout);
    if (!row.sha256) throw unavailable();
    return await consume(path, row.sha256);
  } catch {
    throw unavailable();
  } finally {
    clearTimeout(timeout);
    try {
      release?.();
    } catch {
      /* Leave uncertain ownership reserved. */
    }
  }
}
