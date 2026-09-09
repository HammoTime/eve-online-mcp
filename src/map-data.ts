import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { link, mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { openPromise } from "yauzl";
import * as z from "zod/v4";
import { MAP_DATA_LIMITS, MapCatalog } from "../lib/src/cartography/catalog.js";
import { MAP_DATA_FILES, parseMapData } from "../lib/src/cartography/parse.js";
import {
  MapError,
  type MapData,
  type MapDataStatus,
} from "../lib/src/cartography/types.js";
import {
  jsonLines,
  type StaticDataEntry,
} from "../lib/src/static-data-parser.js";
import { DEFAULT_ESI_USER_AGENT } from "./package-metadata.js";
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

/**
 * Map-only cache: never reads or alters catalog-v1.json or mutable sde-jsonl.zip.
 * Initially downloads the fixed CCP build URL independently of the skill cache.
 * Archives are immutable, addressed by build AND digest. Publish the complete
 * archive first, then atomically replace the index, the sole commit point.
 */
export class LocalMapDataSource {
  private readonly directory: string;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly readArchive: typeof readMapArchive;
  private readonly maxArchiveBytes: number;
  private inFlight: Promise<MapResult> | undefined;
  private saved: SavedMap | undefined;
  private warning: string | undefined;

  constructor(options: LocalMapDataOptions = {}) {
    this.directory = options.directory ?? defaultStaticDataDirectory();
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
    this.inFlight = this.load(refresh).finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  private result(warning?: string): MapResult {
    if (!this.saved)
      throw new MapError(
        "MAP_DATA_UNAVAILABLE",
        "Map data has not been initialized.",
      );
    this.warning = warning;
    const { catalog, checkedAt } = this.saved;
    const { buildNumber, releaseDate, sourceUrl, fetchedAt } = catalog.data;
    return {
      catalog,
      status: {
        buildNumber,
        releaseDate,
        sourceUrl,
        fetchedAt,
        checkedAt,
        stale: warning !== undefined,
        ...(warning ? { warning } : {}),
      },
    };
  }

  private async persist(saved: SavedMap): Promise<void> {
    const temporary = join(this.directory, `map-index-${randomUUID()}.tmp`);
    const catalog = saved.catalog.data;
    const text = JSON.stringify({
      schemaVersion: 1,
      checkedAt: saved.checkedAt,
      etag: saved.etag,
      sha256: checksum(catalog),
      archiveSha256: saved.archiveSha256,
      catalog,
    });
    if (Buffer.byteLength(text) > MAX_INDEX_BYTES)
      throw new Error("Map index exceeds byte limit");
    try {
      await writeFile(temporary, text, { flag: "wx" });
      await rename(temporary, join(this.directory, INDEX_FILE));
    } finally {
      await rm(temporary, { force: true });
    }
  }

  private async load(refresh: boolean): Promise<MapResult> {
    let temporary: string | undefined;
    try {
      await mkdir(this.directory, { recursive: true });
      if (!this.saved) {
        try {
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
          this.saved = {
            catalog,
            checkedAt: index.checkedAt,
            etag: index.etag,
            archiveSha256: index.archiveSha256,
          };
        } catch {
          // A corrupt/incomplete index is never usable as an empty or stale map.
        }
      }
      const age = this.saved
        ? this.now() - Date.parse(this.saved.checkedAt)
        : Infinity;
      if (!refresh && age >= 0 && age < 300_000)
        return this.result(this.warning);
      const signal = AbortSignal.timeout(180_000);
      const response = await this.fetcher(SDE_LATEST_URL, {
        headers: {
          "User-Agent": DEFAULT_ESI_USER_AGENT,
          ...(this.saved?.etag ? { "If-None-Match": this.saved.etag } : {}),
        },
        redirect: "error",
        signal,
      });
      let latest: z.infer<typeof latestRecordSchema> | undefined;
      let etag = this.saved?.etag ?? null;
      if (response.status !== 304 || !this.saved) {
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
        this.saved &&
        latest &&
        latest.buildNumber < this.saved.catalog.data.buildNumber
      )
        return this.result(
          "CCP returned an older build; retained the newer validated map cache.",
        );
      if (
        this.saved &&
        (!latest || latest.buildNumber === this.saved.catalog.data.buildNumber)
      ) {
        if (
          latest &&
          latest.releaseDate !== this.saved.catalog.data.releaseDate
        )
          throw new Error("Map release identity changed for the same build");
        const saved = {
          ...this.saved,
          checkedAt: new Date(this.now()).toISOString(),
          etag,
        };
        await this.persist(saved);
        this.saved = saved;
        return this.result();
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
      const archivePath = join(
        this.directory,
        archiveName(latest.buildNumber, archiveSha256),
      );
      try {
        // Hard-link publication is atomic and cannot overwrite another reader's archive.
        await link(temporary, archivePath);
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !("code" in error) ||
          error.code !== "EEXIST"
        )
          throw error;
        if (
          (await archiveChecksum(archivePath, this.maxArchiveBytes)) !==
          archiveSha256
        )
          throw new Error("Existing immutable map archive is corrupt", {
            cause: error,
          });
      }
      const saved = {
        catalog,
        checkedAt: new Date(this.now()).toISOString(),
        etag,
        archiveSha256,
      };
      await this.persist(saved);
      this.saved = saved;
      return this.result();
    } catch {
      if (this.saved)
        return this.result(
          "Map SDE check, download or validation failed; using the last validated local build.",
        );
      throw new MapError(
        "MAP_DATA_UNAVAILABLE",
        "Map data is unavailable: CCP SDE download, validation or local cache publication failed. Retry initialization.",
      );
    } finally {
      // Cleanup failure must not discard a successfully published or last-good map.
      if (temporary)
        await rm(temporary, { force: true }).catch(() => undefined);
    }
  }
}
