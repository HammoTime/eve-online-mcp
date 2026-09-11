import { randomUUID } from "node:crypto";
import { mkdir, open, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import * as z from "zod/v4";
import { DEFAULT_ESI_USER_AGENT } from "./package-metadata.js";
import { readStaticArchive } from "./static-data-archive.js";
import { SkillCatalog, typeId } from "./skill-data.js";
import {
  SkillStore,
  skillBuildSourceUrl,
  type SavedSkills,
} from "./skill-store.js";

const ORIGIN = "https://developers.eveonline.com";
export const SDE_LATEST_URL = `${ORIGIN}/static-data/tranquility/latest.jsonl`;
export const latestRecordSchema = z.object({
  _key: z.literal("sde"),
  buildNumber: typeId,
  releaseDate: z.iso.datetime(),
});

export function defaultStaticDataDirectory(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  if (env.EVE_SDE_CACHE_DIR) return env.EVE_SDE_CACHE_DIR;
  const base =
    platform === "win32"
      ? (env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"))
      : platform === "darwin"
        ? join(homedir(), "Library", "Caches")
        : (env.XDG_CACHE_HOME ?? join(homedir(), ".cache"));
  return join(base, "eve-online-mcp", "sde");
}
import type { StaticDataSource } from "../lib/src/static-data.js";
export type { StaticDataSource } from "../lib/src/static-data.js";

interface CacheOptions {
  directory?: string;
  fetchImplementation?: typeof fetch;
  now?: () => number;
  readArchive?: typeof readStaticArchive;
  maxArchiveBytes?: number;
}

/** One validated in-memory build per plan, backed by fenced SQLite publication. */
export class StaticDataCache implements StaticDataSource {
  private readonly directory: string;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly readArchive: typeof readStaticArchive;
  private readonly maxArchiveBytes: number;
  private inFlight: ReturnType<StaticDataSource["initialize"]> | undefined;
  private lastWarning: string | undefined;
  private saved: SavedSkills | undefined;
  private readonly store: SkillStore;
  constructor(options: CacheOptions = {}) {
    this.directory = options.directory ?? defaultStaticDataDirectory();
    this.store = new SkillStore(this.directory);
    this.fetcher = options.fetchImplementation ?? fetch;
    this.now = options.now ?? Date.now;
    this.readArchive = options.readArchive ?? readStaticArchive;
    this.maxArchiveBytes = options.maxArchiveBytes ?? 256_000_000;
  }
  initialize(refresh = false) {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.load(refresh).finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }
  private result(stale = false, warning?: string) {
    if (!this.saved) throw new Error("Static data has not been initialized");
    this.lastWarning = warning;
    const { data } = this.saved.catalog;
    return {
      catalog: this.saved.catalog,
      status: {
        buildNumber: data.buildNumber,
        releaseDate: data.releaseDate,
        sourceUrl: data.sourceUrl,
        fetchedAt: data.fetchedAt,
        checkedAt: this.saved.checkedAt,
        stale,
        cacheDirectory: this.directory,
        typeCount: data.types.length,
        skillCount: data.types.filter(
          (type) => type.categoryId === 16 && type.published,
        ).length,
        ...(warning ? { warning } : {}),
      },
    };
  }
  private published(result: ReturnType<SkillStore["publish"]>) {
    this.saved = result.saved;
    return result.accepted
      ? this.result()
      : this.result(
          true,
          "SDE cache changed during refresh; retained the validated stored build.",
        );
  }
  private async load(refresh: boolean) {
    try {
      await mkdir(this.directory, { recursive: true });
      if (!this.saved) {
        this.saved = this.store.read();
        if (!this.saved && !this.store.exists()) {
          // Empty initialized stores retry downloads; only absent databases may
          // import legacy data. Publication also fences concurrent initialization.
          const legacy = await this.store.readLegacy().catch(() => undefined);
          if (legacy) this.saved = this.store.publish(legacy, true).saved;
        }
      }
    } catch {
      if (this.saved)
        return this.result(
          true,
          "SDE cache is unavailable; retained the last validated build.",
        );
      throw new Error(
        "Static data is unavailable. Check the local SDE cache configuration and retry initialize_static_data.",
      );
    }
    const age = this.saved
      ? this.now() - Date.parse(this.saved.checkedAt)
      : Infinity;
    if (!refresh && age >= 0 && age < 300_000)
      return this.result(this.lastWarning !== undefined, this.lastWarning);
    const signal = AbortSignal.timeout(180_000);
    const headers = {
      "User-Agent": DEFAULT_ESI_USER_AGENT,
      ...(this.saved?.etag ? { "If-None-Match": this.saved.etag } : {}),
    };
    let latest: z.infer<typeof latestRecordSchema>;
    let etag: string | null;
    try {
      const response = await this.fetcher(SDE_LATEST_URL, {
        headers,
        redirect: "error",
        signal,
      });
      if (response.status === 304 && this.saved) {
        if (!this.saved.etag)
          throw new Error("Unexpected unconditional SDE 304");
        return this.published(
          this.store.check(
            this.saved,
            new Date(this.now()).toISOString(),
            this.saved.etag,
          ),
        );
      }
      if (!response.ok || !response.body)
        throw new Error("SDE latest-build request failed");
      let text = "";
      const reader = response.body.getReader();
      try {
        let size = 0;
        const decoder = new TextDecoder();
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.byteLength;
          if (size > 65536) throw new Error("SDE manifest exceeds byte limit");
          text += decoder.decode(part.value, { stream: true });
        }
        text += decoder.decode();
      } finally {
        await reader.cancel();
      }
      const records = text
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
        throw new Error("SDE manifest must contain exactly one build");
      latest = latestRecordSchema.parse(matches[0]);
      etag = response.headers.get("etag");
    } catch {
      if (this.saved)
        return this.result(
          true,
          "Could not check CCP's current SDE; using the last validated local build.",
        );
      throw new Error(
        "Static data is unavailable. Retry initialize_static_data when CCP is reachable.",
      );
    }
    if (this.saved && latest.buildNumber < this.saved.catalog.data.buildNumber)
      return this.result(
        true,
        "CCP returned an older build; retained the newer validated cache.",
      );
    if (this.saved?.catalog.data.buildNumber === latest.buildNumber) {
      try {
        if (this.saved.catalog.data.releaseDate !== latest.releaseDate)
          throw new Error("Conflicting SDE build identity");
        return this.published(
          this.store.check(
            this.saved,
            new Date(this.now()).toISOString(),
            etag,
          ),
        );
      } catch {
        return this.result(
          true,
          "SDE refresh could not be published; retained the last validated build.",
        );
      }
    }
    const sourceUrl = skillBuildSourceUrl(latest.buildNumber);
    const temporary = join(this.directory, `archive-${randomUUID()}.tmp`);
    try {
      try {
        if (
          !Number.isSafeInteger(this.maxArchiveBytes) ||
          this.maxArchiveBytes <= 0
        )
          throw new Error("Invalid SDE archive byte limit");
        const response = await this.fetcher(sourceUrl, {
          headers: { "User-Agent": DEFAULT_ESI_USER_AGENT },
          redirect: "error",
          signal,
        });
        if (!response.ok || !response.body)
          throw new Error("SDE archive request failed");
        if (
          Number(response.headers.get("content-length")) > this.maxArchiveBytes
        ) {
          await response.body.cancel();
          throw new Error("SDE archive exceeds byte limit");
        }
        const reader = response.body.getReader();
        try {
          const file = await open(temporary, "wx");
          try {
            let size = 0;
            for (;;) {
              const part = await reader.read();
              if (part.done) break;
              size += part.value.byteLength;
              if (size > this.maxArchiveBytes)
                throw new Error("SDE archive exceeds byte limit");
              await file.writeFile(part.value);
            }
          } finally {
            await file.close();
          }
        } finally {
          await reader.cancel();
        }
        const data = await this.readArchive(temporary, {
          buildNumber: latest.buildNumber,
          releaseDate: latest.releaseDate,
          sourceUrl,
          fetchedAt: new Date(this.now()).toISOString(),
        });
        const catalog = new SkillCatalog(data);
        if (
          data.buildNumber !== latest.buildNumber ||
          data.releaseDate !== latest.releaseDate
        )
          throw new Error("SDE archive metadata mismatch");
        return this.published(
          this.store.publish({
            catalog,
            checkedAt: new Date(this.now()).toISOString(),
            etag,
          }),
        );
      } finally {
        await rm(temporary, { force: true });
      }
    } catch {
      if (this.saved)
        return this.result(
          true,
          "SDE refresh failed validation or download; retained the last validated build.",
        );
      throw new Error(
        "SDE download or validation failed. No skill plan can be generated; retry initialize_static_data.",
      );
    }
  }
}
