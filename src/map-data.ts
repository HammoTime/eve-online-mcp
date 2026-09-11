import { createHash, randomUUID } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, open, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { openPromise } from "yauzl";
import * as z from "zod/v4";
import { MAP_DATA_LIMITS, MapCatalog } from "../lib/src/cartography/catalog.js";
import { MAP_DATA_FILES, parseMapData } from "../lib/src/cartography/parse.js";
import { parseMapRequest } from "../lib/src/cartography/references.js";
import type { PreparedMapDataSource } from "../lib/src/cartography/service.js";
import {
  MapError,
  type MapData,
  type MapDataStatus,
  type MapRequest,
} from "../lib/src/cartography/types.js";
import {
  jsonLines,
  type StaticDataEntry,
} from "../lib/src/static-data-parser.js";
import { DEFAULT_ESI_USER_AGENT } from "./package-metadata.js";
import {
  LocalMapStore,
  MAP_DATABASE_FILE,
  type MapSnapshot,
} from "./map-store.js";
import {
  defaultStaticDataDirectory,
  latestRecordSchema,
  SDE_LATEST_URL,
} from "./static-data.js";

type MapMetadata = Omit<
  MapData,
  "schemaVersion" | "systems" | "regions" | "constellations" | "gates"
>;
interface MapResult {
  catalog: MapCatalog;
  status: MapDataStatus;
}
const MAX_ARCHIVE_BYTES = 256_000_000;
const MAX_INDEX_BYTES = 64_000_000;
const INDEX_FILE = "map-catalog-v1.json";
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const indexSchema = z.object({
  schemaVersion: z.literal(1),
  checkedAt: z.iso.datetime(),
  etag: z
    .string()
    .max(1024)
    .refine((value) => !/[\r\n]/.test(value))
    .nullable(),
  sha256: digestSchema,
  archiveSha256: digestSchema,
  catalog: z.unknown(),
});

async function* mapEntries(path: string): AsyncGenerator<StaticDataEntry> {
  const zip = await openPromise(path, {
    lazyEntries: true,
    strictFileNames: true,
    validateEntrySizes: true,
  });
  try {
    let count = 0;
    for await (const entry of zip.eachEntry()) {
      if (++count > MAP_DATA_LIMITS.entries)
        throw new MapError(
          "MAP_DATA_LIMIT",
          "Map archive entry count exceeds limit.",
        );
      // Do not extract, normalize or basename-match untrusted archive paths.
      if (!MAP_DATA_FILES.includes(entry.fileName)) continue;
      if (entry.uncompressedSize > MAP_DATA_LIMITS.entryBytes)
        throw new MapError(
          "MAP_DATA_LIMIT",
          "Map archive entry exceeds byte limit.",
        );
      const stream: Readable = await zip.openReadStreamPromise(entry);
      try {
        yield {
          name: entry.fileName,
          rows: jsonLines(stream, MAP_DATA_LIMITS.entryBytes),
        };
      } finally {
        stream.destroy();
      }
    }
  } finally {
    zip.close();
  }
}

export function readMapArchive(
  path: string,
  metadata: MapMetadata,
): Promise<MapData> {
  return parseMapData(mapEntries(path), metadata);
}

export interface LocalMapDataOptions {
  directory?: string;
  fetchImplementation?: typeof fetch;
  now?: () => number;
  readArchive?: typeof readMapArchive;
  maxArchiveBytes?: number;
}

interface SavedMap {
  catalog: MapCatalog;
  checkedAt: string;
  etag: string | null;
  archiveSha256: string;
}

function sourceUrl(build: number): string {
  return SDE_LATEST_URL.replace(
    "latest.jsonl",
    `eve-online-static-data-${build}-jsonl.zip`,
  );
}
function archiveName(build: number, sha256: string): string {
  return `map-sde-${build}-${sha256}.zip`;
}
function checksum(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
async function archiveChecksum(path: string, limit: number): Promise<string> {
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of createReadStream(path)) {
    const bytes = chunk as Buffer;
    if ((size += bytes.byteLength) > limit)
      throw new Error("Map archive exceeds byte limit");
    hash.update(bytes);
  }
  return hash.digest("hex");
}

function sameBuild(left: MapSnapshot, right: MapSnapshot): boolean {
  return (
    left.source.buildNumber === right.source.buildNumber &&
    left.source.releaseDate === right.source.releaseDate &&
    left.source.sourceUrl === right.source.sourceUrl &&
    left.archiveSha256 === right.archiveSha256
  );
}

/** Map-only SQLite cache. Full catalogs are retained only by legacy initialize(). */
export class LocalMapDataSource implements PreparedMapDataSource {
  private readonly directory: string;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly readArchive: typeof readMapArchive;
  private readonly maxArchiveBytes: number;
  private readonly store: LocalMapStore;
  private inFlight: Promise<MapResult> | undefined;
  private metadataInFlight: Promise<void> | undefined;
  private saved: MapSnapshot | undefined;
  private catalog: MapCatalog | undefined;
  private warning: string | undefined;

  constructor(options: LocalMapDataOptions = {}) {
    this.directory = options.directory ?? defaultStaticDataDirectory();
    this.store = new LocalMapStore(this.directory);
    this.fetcher = options.fetchImplementation ?? fetch;
    this.now = options.now ?? Date.now;
    this.readArchive = options.readArchive ?? readMapArchive;
    this.maxArchiveBytes = options.maxArchiveBytes ?? MAX_ARCHIVE_BYTES;
    if (
      !Number.isSafeInteger(this.maxArchiveBytes) ||
      this.maxArchiveBytes < 1 ||
      this.maxArchiveBytes > MAX_ARCHIVE_BYTES
    )
      throw new MapError("MAP_DATA_LIMIT", "Invalid map archive byte limit.");
  }

  initialize(refresh = false): Promise<MapResult> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.ensure(refresh)
      .then(() => {
        try {
          if (!this.catalog) {
            const { catalog, snapshot } = this.store.loadCatalog();
            this.remember(snapshot, this.warning);
            this.catalog = catalog;
          }
          if (!this.saved) throw this.unavailable();
          return { catalog: this.catalog, status: this.status(this.saved) };
        } catch {
          throw this.unavailable();
        }
      })
      .finally(() => {
        this.inFlight = undefined;
      });
    return this.inFlight;
  }

  async prepare(request: MapRequest, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const input = parseMapRequest(request);
    signal?.throwIfAborted();
    // Cancellation belongs to this waiter, not the shared public download.
    const pending = this.ensure(false);
    await new Promise<void>((resolve, reject) => {
      const abort = () => {
        resolve();
      };
      signal?.addEventListener("abort", abort, { once: true });
      void pending.then(resolve, reject).finally(() => {
        signal?.removeEventListener("abort", abort);
      });
    });
    signal?.throwIfAborted();
    try {
      const { scene, snapshot } = this.store.prepare(input, signal);
      this.remember(snapshot, this.warning);
      return { scene, status: this.status(snapshot) };
    } catch (error) {
      signal?.throwIfAborted();
      if (
        error instanceof MapError &&
        [
          "MAP_REFERENCE_UNKNOWN",
          "MAP_REFERENCE_AMBIGUOUS",
          "EMPTY_MAP_BOUNDARY",
          "MAP_TOO_LARGE",
          "OUT_OF_BOUNDARY",
          "INVALID_ROUTE_ADJACENCY",
        ].includes(error.code)
      )
        throw error;
      throw this.unavailable();
    }
  }

  private ensure(refresh: boolean): Promise<void> {
    if (this.metadataInFlight) return this.metadataInFlight;
    this.metadataInFlight = this.load(refresh).finally(() => {
      this.metadataInFlight = undefined;
    });
    return this.metadataInFlight;
  }

  private status(snapshot: MapSnapshot): MapDataStatus {
    return {
      ...snapshot.source,
      checkedAt: snapshot.checkedAt,
      stale: this.warning !== undefined,
      ...(this.warning ? { warning: this.warning } : {}),
    };
  }

  private unavailable(): MapError {
    this.warning =
      "The last validated map metadata is available, but local map data could not be read.";
    return new MapError(
      "MAP_DATA_UNAVAILABLE",
      "Map data is unavailable: CCP SDE download, validation or local cache publication failed. Retry initialization.",
      this.saved ? { status: this.status(this.saved) } : {},
    );
  }

  private remember(snapshot: MapSnapshot, warning?: string): void {
    if (snapshot.source.sourceUrl !== sourceUrl(snapshot.source.buildNumber))
      throw new Error("Map build identity mismatch");
    if (
      this.catalog &&
      (!this.saved ||
        !sameBuild(this.saved, snapshot) ||
        this.saved.source.fetchedAt !== snapshot.source.fetchedAt)
    )
      this.catalog = undefined;
    this.saved = snapshot;
    this.warning = warning;
  }

  private published(snapshot: MapSnapshot, expected: MapSnapshot): void {
    this.remember(
      snapshot,
      sameBuild(snapshot, expected) &&
        snapshot.checkedAt === expected.checkedAt &&
        snapshot.etag === expected.etag
        ? undefined
        : "Map cache changed during refresh; retained the validated stored build.",
    );
  }

  private async readLegacy(): Promise<SavedMap> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of createReadStream(
      join(this.directory, INDEX_FILE),
    )) {
      const bytes = chunk as Buffer;
      if ((size += bytes.byteLength) > MAX_INDEX_BYTES)
        throw new Error("Map index exceeds byte limit");
      chunks.push(bytes);
    }
    const index = indexSchema.parse(
      JSON.parse(Buffer.concat(chunks).toString("utf8")),
    );
    if (checksum(index.catalog) !== index.sha256)
      throw new Error("Map index checksum mismatch");
    const catalog = new MapCatalog(index.catalog as MapData);
    if (catalog.data.sourceUrl !== sourceUrl(catalog.data.buildNumber))
      throw new Error("Map build identity mismatch");
    if (
      (await archiveChecksum(
        join(
          this.directory,
          archiveName(catalog.data.buildNumber, index.archiveSha256),
        ),
        this.maxArchiveBytes,
      )) !== index.archiveSha256
    )
      throw new Error("Map archive checksum mismatch");
    return {
      catalog,
      checkedAt: index.checkedAt,
      etag: index.etag,
      archiveSha256: index.archiveSha256,
    };
  }

  private async load(refresh: boolean): Promise<void> {
    try {
      await mkdir(this.directory, { recursive: true });
      // SQLite is authoritative even if corrupt or from a future schema version.
      const snapshot = this.store.read();
      if (snapshot) {
        this.remember(
          snapshot,
          this.saved && JSON.stringify(this.saved) === JSON.stringify(snapshot)
            ? this.warning
            : undefined,
        );
      } else if (this.saved) {
        throw new Error("Local map snapshot disappeared");
      } else if (!existsSync(join(this.directory, MAP_DATABASE_FILE))) {
        const legacy = await this.readLegacy().catch(() => undefined);
        if (legacy) {
          const { catalog, ...metadata } = legacy;
          this.published(this.store.publish(catalog, metadata), {
            source: {
              buildNumber: catalog.data.buildNumber,
              releaseDate: catalog.data.releaseDate,
              sourceUrl: catalog.data.sourceUrl,
              fetchedAt: catalog.data.fetchedAt,
            },
            ...metadata,
          });
        }
      }
    } catch {
      throw this.unavailable();
    }
    let temporary: string | undefined;
    try {
      const age = this.saved
        ? this.now() - Date.parse(this.saved.checkedAt)
        : Infinity;
      if (!refresh && age >= 0 && age < 300_000) return;
      const expected = this.saved;
      const signal = AbortSignal.timeout(180_000);
      const response = await this.fetcher(SDE_LATEST_URL, {
        headers: {
          "User-Agent": DEFAULT_ESI_USER_AGENT,
          ...(expected?.etag ? { "If-None-Match": expected.etag } : {}),
        },
        redirect: "error",
        signal,
      });
      let latest: z.infer<typeof latestRecordSchema> | undefined;
      let etag = expected?.etag ?? null;
      if (response.status === 304 && !etag)
        throw new Error("Unexpected unconditional map 304");
      if (response.status !== 304) {
        if (!response.ok || !response.body) {
          await response.body?.cancel();
          throw new Error("Map manifest request failed");
        }
        const reader = response.body.getReader();
        let text = "";
        try {
          let size = 0;
          const decoder = new TextDecoder();
          for (;;) {
            const part = await reader.read();
            if (part.done) break;
            if ((size += part.value.byteLength) > 65_536)
              throw new Error("Map manifest exceeds byte limit");
            text += decoder.decode(part.value, { stream: true });
          }
          text += decoder.decode();
        } finally {
          await reader.cancel();
        }
        const records: unknown[] = text
          .split("\n")
          .filter((line) => line.trim())
          .map((line) => JSON.parse(line) as unknown);
        const matches = records.filter(
          (row) =>
            typeof row === "object" &&
            row !== null &&
            "_key" in row &&
            row._key === "sde",
        );
        if (matches.length !== 1)
          throw new Error("Map manifest must contain exactly one build");
        latest = latestRecordSchema.parse(matches[0]);
        etag = response.headers.get("etag");
        if (etag && (etag.length > 1024 || /[\r\n]/.test(etag)))
          throw new Error("Invalid map manifest ETag");
      }
      if (
        expected &&
        latest &&
        latest.buildNumber < expected.source.buildNumber
      ) {
        this.remember(
          this.store.read() ?? expected,
          "CCP returned an older build; retained the newer validated map cache.",
        );
        return;
      }
      if (
        expected &&
        (!latest || latest.buildNumber === expected.source.buildNumber)
      ) {
        if (latest && latest.releaseDate !== expected.source.releaseDate)
          throw new Error("Map release identity changed for the same build");
        const saved = {
          ...expected,
          checkedAt: new Date(this.now()).toISOString(),
          etag,
        };
        this.published(
          this.store.touch(expected, saved.checkedAt, etag),
          saved,
        );
        return;
      }
      if (!latest) throw new Error("Map manifest has no build");
      const metadata: MapMetadata = Object.freeze({
        buildNumber: latest.buildNumber,
        releaseDate: latest.releaseDate,
        sourceUrl: sourceUrl(latest.buildNumber),
        fetchedAt: new Date(this.now()).toISOString(),
      });
      const archive = await this.fetcher(metadata.sourceUrl, {
        headers: { "User-Agent": DEFAULT_ESI_USER_AGENT },
        redirect: "error",
        signal,
      });
      if (
        !archive.ok ||
        !archive.body ||
        Number(archive.headers.get("content-length")) > this.maxArchiveBytes
      ) {
        await archive.body?.cancel();
        throw new Error("Map archive request failed or exceeds byte limit");
      }
      temporary = join(this.directory, `map-archive-${randomUUID()}.tmp`);
      const reader = archive.body.getReader();
      const hash = createHash("sha256");
      try {
        const file = await open(temporary, "wx");
        try {
          let size = 0;
          for (;;) {
            const part = await reader.read();
            if (part.done) break;
            if ((size += part.value.byteLength) > this.maxArchiveBytes)
              throw new Error("Map archive exceeds byte limit");
            hash.update(part.value);
            await file.writeFile(part.value);
          }
        } finally {
          await file.close();
        }
      } finally {
        await reader.cancel();
      }
      const data = await this.readArchive(temporary, metadata);
      // An injected reader must not mislabel a downloaded build, even with valid data.
      if (
        data.buildNumber !== metadata.buildNumber ||
        data.releaseDate !== metadata.releaseDate ||
        data.sourceUrl !== metadata.sourceUrl ||
        data.fetchedAt !== metadata.fetchedAt
      )
        throw new Error(
          "Parsed map metadata does not match the requested build",
        );
      const catalog = new MapCatalog(data);
      const archiveSha256 = hash.digest("hex");
      const saved = {
        checkedAt: new Date(this.now()).toISOString(),
        etag,
        archiveSha256,
      };
      this.published(this.store.publish(catalog, saved), {
        source: metadata,
        ...saved,
      });
    } catch {
      if (!this.saved) throw this.unavailable();
      this.warning =
        "Map SDE check, download or validation failed; using the last validated local build.";
    } finally {
      // Cleanup failure must not discard a successfully published or last-good map.
      if (temporary)
        await rm(temporary, { force: true }).catch(() => undefined);
    }
  }
}
