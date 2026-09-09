import { createHash, randomBytes } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import * as z from "zod/v4";
import { defaultStaticDataDirectory } from "./static-data.js";
import {
  MapError,
  MAP_LIMITS,
  type MapDataStatus,
  type RenderedMap,
} from "../lib/src/cartography/types.js";
import type {
  MapArtifact,
  MapArtifactStore,
} from "../lib/src/cartography/service.js";

const idPattern = /^[a-f0-9]{32}$/;
const manifestSchema = z.object({
  version: z.literal(1),
  id: z.string().regex(idPattern),
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  bytes: z.number().int().min(1).max(MAP_LIMITS.svgBytes),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  width: z.number().int(),
  height: z.number().int(),
  title: z.string(),
  source: z.record(z.string(), z.json()),
  summary: z.record(z.string(), z.json()),
});
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");

export class LocalMapArtifacts implements MapArtifactStore {
  private readonly directory: string;
  private readonly now: () => number;
  private readonly retentionMs: number;
  private readonly maxBytes: number;
  private pending = Promise.resolve();
  constructor(
    options: {
      directory?: string;
      now?: () => number;
      retentionMs?: number;
      maxBytes?: number;
    } = {},
  ) {
    this.directory = resolve(
      options.directory ??
        process.env.EVE_MAP_ARTIFACT_DIR ??
        join(defaultStaticDataDirectory(), "maps"),
    );
    this.now = options.now ?? Date.now;
    this.retentionMs = options.retentionMs ?? 7 * 24 * 3600_000;
    this.maxBytes = options.maxBytes ?? 100_000_000;
    if (
      !Number.isSafeInteger(this.retentionMs) ||
      this.retentionMs <= 0 ||
      !Number.isSafeInteger(this.maxBytes) ||
      this.maxBytes <= 0
    )
      throw new MapError(
        "MAP_STORAGE_INVALID",
        "Invalid map artifact storage limits.",
      );
  }
  private async root() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    if ((await lstat(this.directory)).isSymbolicLink())
      throw new Error("Artifact root cannot be a symlink");
    return realpath(this.directory);
  }
  private async location(id: string) {
    if (!idPattern.test(id)) throw new Error("Invalid map artifact ID");
    const root = await this.root();
    const path = join(root, id);
    const info = await lstat(path);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (await realpath(path)) !== path
    )
      throw new Error("Invalid artifact directory");
    return path;
  }
  private async text(path: string, limit: number) {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > limit)
      throw new Error("Invalid artifact file");
    const file = await open(path, "r");
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > limit || stat.ino !== info.ino)
        throw new Error("Artifact changed during read");
      const bytes = Buffer.alloc(limit + 1);
      let used = 0;
      while (used <= limit) {
        const { bytesRead } = await file.read(
          bytes,
          used,
          limit + 1 - used,
          used,
        );
        if (!bytesRead) break;
        used += bytesRead;
      }
      if (used > limit) throw new Error("Artifact exceeds byte limit");
      return bytes.subarray(0, used).toString("utf8");
    } finally {
      await file.close();
    }
  }
  put(map: RenderedMap, source: MapDataStatus): Promise<MapArtifact> {
    const operation = this.pending.then(() => this.publish(map, source));
    this.pending = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }
  private async publish(
    map: RenderedMap,
    source: MapDataStatus,
  ): Promise<MapArtifact> {
    const root = await this.root();
    const id = randomBytes(16).toString("hex");
    const createdAt = new Date(this.now()).toISOString();
    const expiresAt = new Date(this.now() + this.retentionMs).toISOString();
    const bytes = Buffer.byteLength(map.svg);
    const sha256 = digest(map.svg);
    const manifest = JSON.stringify(
      manifestSchema.parse({
        version: 1,
        id,
        createdAt,
        expiresAt,
        bytes,
        sha256,
        width: map.width,
        height: map.height,
        title: map.title,
        source,
        summary: map.summary,
      }),
    );
    if (Buffer.byteLength(manifest) > 100_000)
      throw new MapError(
        "MAP_STORAGE_LIMIT",
        "Artifact manifest exceeds its read limit.",
      );
    const total = bytes + Buffer.byteLength(manifest);
    if (total > this.maxBytes)
      throw new MapError(
        "MAP_STORAGE_LIMIT",
        "Artifact exceeds the configured storage capacity.",
      );
    const candidates: { path: string; bytes: number; createdAt: string }[] = [];
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (
        !idPattern.test(entry.name) ||
        !entry.isDirectory() ||
        entry.isSymbolicLink()
      )
        continue;
      try {
        const path = await this.location(entry.name);
        const text = await this.text(join(path, "manifest.json"), 100_000);
        const saved = manifestSchema.parse(JSON.parse(text));
        if (saved.id !== entry.name) continue;
        if (Date.parse(saved.expiresAt) <= this.now())
          await rm(path, { recursive: true });
        else
          candidates.push({
            path,
            bytes: saved.bytes + Buffer.byteLength(text),
            createdAt: saved.createdAt,
          });
      } catch {
        /* Never clean unrelated or unrecognized filesystem content. */
      }
    }
    let used = candidates.reduce((sum, item) => sum + item.bytes, 0);
    for (const item of candidates.sort(
      (a, b) =>
        a.createdAt.localeCompare(b.createdAt) || a.path.localeCompare(b.path),
    )) {
      if (used + total <= this.maxBytes) break;
      await rm(item.path, { recursive: true });
      used -= item.bytes;
    }
    const temporary = join(root, `.new-${id}`);
    try {
      await mkdir(temporary, { mode: 0o700 });
      await writeFile(join(temporary, "map.svg"), map.svg, {
        flag: "wx",
        mode: 0o600,
      });
      await writeFile(join(temporary, "manifest.json"), manifest, {
        flag: "wx",
        mode: 0o600,
      });
      await rename(temporary, join(root, id));
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
    return {
      id,
      uri: `eve-map://artifacts/${id}/map.svg`,
      manifestUri: `eve-map://artifacts/${id}/manifest.json`,
      mimeType: "image/svg+xml",
      bytes,
      sha256,
      width: map.width,
      height: map.height,
      expiresAt,
    };
  }
  async read(id: string, file: "map.svg" | "manifest.json") {
    if (!["map.svg", "manifest.json"].includes(file))
      throw new Error("Unknown map resource");
    const path = await this.location(id);
    const text = await this.text(join(path, "manifest.json"), 100_000);
    const manifest = manifestSchema.parse(JSON.parse(text));
    if (manifest.id !== id || Date.parse(manifest.expiresAt) <= this.now())
      throw new Error("Map artifact expired");
    const svg = await this.text(join(path, "map.svg"), MAP_LIMITS.svgBytes);
    if (
      Buffer.byteLength(svg) !== manifest.bytes ||
      digest(svg) !== manifest.sha256
    )
      throw new Error("Map artifact checksum mismatch");
    return file === "map.svg"
      ? { text: svg, mimeType: "image/svg+xml" }
      : { text, mimeType: "application/json" };
  }
}
