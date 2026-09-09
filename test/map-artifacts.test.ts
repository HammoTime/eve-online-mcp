import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalMapArtifacts } from "../src/map-artifacts.js";
import {
  MAP_LIMITS,
  type MapDataStatus,
  type RenderedMap,
} from "../lib/src/cartography/types.js";

const epoch = Date.parse("2026-09-09T00:00:00Z");
const source: MapDataStatus = {
  buildNumber: 123,
  releaseDate: "2026-09-01T00:00:00Z",
  sourceUrl: "https://example.invalid/map-data.zip",
  fetchedAt: new Date(epoch).toISOString(),
  checkedAt: new Date(epoch).toISOString(),
  stale: false,
};
const map: RenderedMap = {
  svg: '<svg xmlns="http://www.w3.org/2000/svg" width="1440" height="720"><title>Atlas \u00e9</title></svg>',
  width: 1440,
  height: 720,
  title: "Synthetic Atlas",
  summary: {
    systemCount: 0,
    edgeCount: 0,
    boundaryLabel: "",
    routes: [],
    pointsOfInterest: [],
  },
  layout: { requested: "atlas", used: "atlas", coordinateBasis: "synthetic" },
  completeness: { omittedLabels: 0, boundaryConnections: 0 },
  warnings: [],
};

describe("local map artifacts", () => {
  let temporary: string;
  let directory: string;
  let store: LocalMapArtifacts;
  const now = vi.fn(() => epoch);

  beforeEach(async () => {
    temporary = await mkdtemp(join(tmpdir(), "eve-map-artifacts-"));
    directory = join(temporary, "maps");
    now.mockReturnValue(epoch);
    store = new LocalMapArtifacts({ directory, now });
  });
  afterEach(async () => {
    await rm(temporary, { recursive: true, force: true });
  });

  it("publishes matching UTF-8 hashes, metadata and resource URIs readable after restart", async () => {
    const artifact = await store.put(map, source);
    const sha256 = createHash("sha256").update(map.svg).digest("hex");
    expect(artifact).toEqual({
      id: expect.stringMatching(/^[a-f0-9]{32}$/),
      uri: `eve-map://artifacts/${artifact.id}/map.svg`,
      manifestUri: `eve-map://artifacts/${artifact.id}/manifest.json`,
      mimeType: "image/svg+xml",
      bytes: Buffer.byteLength(map.svg),
      sha256,
      width: map.width,
      height: map.height,
      expiresAt: "2026-09-16T00:00:00.000Z",
    });
    expect(artifact.bytes).toBeGreaterThan(map.svg.length);
    const restarted = new LocalMapArtifacts({ directory, now });
    await expect(restarted.read(artifact.id, "map.svg")).resolves.toEqual({
      text: map.svg,
      mimeType: "image/svg+xml",
    });
    const manifest = await restarted.read(artifact.id, "manifest.json");
    expect(manifest.mimeType).toBe("application/json");
    expect(JSON.parse(manifest.text)).toEqual({
      version: 1,
      id: artifact.id,
      createdAt: new Date(epoch).toISOString(),
      expiresAt: artifact.expiresAt,
      bytes: artifact.bytes,
      sha256,
      width: map.width,
      height: map.height,
      title: map.title,
      source,
      summary: map.summary,
    });
    expect(await readdir(directory)).toEqual([artifact.id]);
    expect((await readdir(join(directory, artifact.id))).sort()).toEqual([
      "manifest.json",
      "map.svg",
    ]);
  });

  it("expires at the TTL boundary and cleans only expired artifacts on the next put", async () => {
    store = new LocalMapArtifacts({ directory, now, retentionMs: 1000 });
    const first = await store.put(map, source);
    now.mockReturnValue(epoch + 500);
    const second = await store.put(map, source);
    now.mockReturnValue(epoch + 999);
    await expect(store.read(first.id, "map.svg")).resolves.toHaveProperty(
      "text",
      map.svg,
    );
    now.mockReturnValue(epoch + 1000);
    for (const file of ["map.svg", "manifest.json"] as const) {
      await expect(store.read(first.id, file)).rejects.toThrow("expired");
    }
    await expect(store.read(second.id, "map.svg")).resolves.toHaveProperty(
      "text",
      map.svg,
    );
    const third = await store.put(map, source);
    expect((await readdir(directory)).sort()).toEqual(
      [second.id, third.id].sort(),
    );
  });

  it("counts manifest bytes and evicts oldest-created artifacts, not recently unread ones", async () => {
    const first = await store.put(map, source);
    const manifest = await store.read(first.id, "manifest.json");
    const total = first.bytes + Buffer.byteLength(manifest.text);
    store = new LocalMapArtifacts({ directory, now, maxBytes: total * 2 });
    now.mockReturnValue(epoch + 1000);
    const second = await store.put(map, source);
    now.mockReturnValue(epoch + 2000);
    await store.read(first.id, "map.svg");
    const third = await store.put(map, source);
    expect((await readdir(directory)).sort()).toEqual(
      [second.id, third.id].sort(),
    );
    await expect(store.read(first.id, "map.svg")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(store.read(second.id, "map.svg")).resolves.toHaveProperty(
      "text",
      map.svg,
    );
    await expect(store.read(third.id, "map.svg")).resolves.toHaveProperty(
      "text",
      map.svg,
    );
  });

  it("leaves unrecognized manifests and unrelated filesystem content untouched during eviction", async () => {
    const artifact = await store.put(map, source);
    const { text } = await store.read(artifact.id, "manifest.json");
    const manifest = JSON.parse(text);
    const unknown = [
      ["a".repeat(32), "{broken"],
      [
        "b".repeat(32),
        JSON.stringify({ ...manifest, version: 2, id: "b".repeat(32) }),
      ],
      ["c".repeat(32), JSON.stringify({ ...manifest, id: "d".repeat(32) })],
      ["e".repeat(32), JSON.stringify({ version: 1, id: "e".repeat(32) })],
      ["unrelated", text],
    ] as const;
    for (const [id, content] of unknown) {
      await mkdir(join(directory, id));
      await writeFile(join(directory, id, "manifest.json"), content);
      await writeFile(join(directory, id, "sentinel"), "keep");
    }
    await writeFile(join(directory, "f".repeat(32)), "ordinary file");
    now.mockReturnValue(epoch + 8 * 24 * 3600_000);
    store = new LocalMapArtifacts({
      directory,
      now,
      maxBytes: artifact.bytes + Buffer.byteLength(text),
    });
    const next = await store.put(map, source);
    expect((await readdir(directory)).sort()).toEqual(
      [...unknown.map(([id]) => id), "f".repeat(32), next.id].sort(),
    );
    for (const [id, content] of unknown) {
      expect(await readFile(join(directory, id, "manifest.json"), "utf8")).toBe(
        content,
      );
      expect(await readFile(join(directory, id, "sentinel"), "utf8")).toBe(
        "keep",
      );
    }
    expect(await readFile(join(directory, "f".repeat(32)), "utf8")).toBe(
      "ordinary file",
    );
  });

  it("rejects arbitrary IDs and filenames even when called outside the TypeScript boundary", async () => {
    const { id } = await store.put(map, source);
    for (const invalid of [
      "",
      "../" + id,
      join(directory, id),
      "A".repeat(32),
      "g".repeat(32),
      "a".repeat(31),
      "a".repeat(33),
      id + "/../" + id,
      id + "\0",
    ]) {
      await expect(store.read(invalid, "map.svg")).rejects.toThrow(
        "Invalid map artifact ID",
      );
    }
    for (const invalid of [
      "../map.svg",
      "../../secret",
      "manifest.json/../map.svg",
      "/etc/passwd",
      "other.json",
      "map.svg\0",
    ]) {
      await expect(store.read(id, invalid as "map.svg")).rejects.toThrow(
        "Unknown map resource",
      );
    }
    await expect(store.read("0".repeat(32), "map.svg")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it.each(["root", "artifact"] as const)(
    "rejects a symlinked %s without reading or cleaning its target",
    async (kind) => {
      const artifact = await store.put(map, source);
      const external = join(temporary, "external");
      const original =
        kind === "root" ? directory : join(directory, artifact.id);
      await rename(original, external);
      await symlink(external, original, "dir");
      for (const file of ["map.svg", "manifest.json"] as const) {
        await expect(store.read(artifact.id, file)).rejects.toThrow();
      }
      now.mockReturnValue(epoch + 8 * 24 * 3600_000);
      if (kind === "root")
        await expect(store.put(map, source)).rejects.toThrow("symlink");
      else await store.put(map, source);
      const target = kind === "root" ? join(external, artifact.id) : external;
      expect(await readFile(join(target, "map.svg"), "utf8")).toBe(map.svg);
      expect((await readdir(target)).sort()).toEqual([
        "manifest.json",
        "map.svg",
      ]);
    },
  );

  it.each(["map.svg", "manifest.json"] as const)(
    "rejects a symlinked %s even when its target has valid contents",
    async (file) => {
      const artifact = await store.put(map, source);
      const path = join(directory, artifact.id, file);
      const external = join(temporary, "outside-file");
      const original = await readFile(path, "utf8");
      await rename(path, external);
      await symlink(external, path, "file");
      for (const resource of ["map.svg", "manifest.json"] as const) {
        await expect(store.read(artifact.id, resource)).rejects.toThrow(
          "Invalid artifact file",
        );
      }
      await store.put(map, source);
      expect(await readFile(external, "utf8")).toBe(original);
    },
  );

  it("verifies the SVG checksum for both resources, including same-byte-length tampering", async () => {
    const artifact = await store.put(map, source);
    const path = join(directory, artifact.id, "map.svg");
    const altered = map.svg.replace("Atlas", "Other");
    expect(Buffer.byteLength(altered)).toBe(artifact.bytes);
    for (const content of [altered, map.svg + " "]) {
      await writeFile(path, content);
      for (const file of ["map.svg", "manifest.json"] as const) {
        await expect(store.read(artifact.id, file)).rejects.toThrow(
          "checksum mismatch",
        );
      }
    }
  });

  it("rejects invalid manifest hashes, identity and expiry rather than trusting metadata", async () => {
    const artifact = await store.put(map, source);
    const path = join(directory, artifact.id, "manifest.json");
    const manifest = JSON.parse(await readFile(path, "utf8"));
    for (const change of [
      { sha256: "0".repeat(64) },
      { sha256: "invalid" },
      { id: "0".repeat(32) },
      { expiresAt: "not a date" },
      { expiresAt: new Date(epoch).toISOString() },
    ]) {
      await writeFile(path, JSON.stringify({ ...manifest, ...change }));
      for (const file of ["map.svg", "manifest.json"] as const) {
        await expect(store.read(artifact.id, file)).rejects.toThrow();
      }
    }
  });

  it("finishes bounded reads at exactly the SVG and manifest limits and rejects one byte over", async () => {
    const prefix = '<svg xmlns="http://www.w3.org/2000/svg"><!--';
    const suffix = "--></svg>";
    const svg =
      prefix +
      "x".repeat(MAP_LIMITS.svgBytes - prefix.length - suffix.length) +
      suffix;
    const artifact = await store.put({ ...map, svg }, source);
    const manifestPath = join(directory, artifact.id, "manifest.json");
    const original = await readFile(manifestPath, "utf8");
    const padded = original + " ".repeat(100_000 - Buffer.byteLength(original));
    await writeFile(manifestPath, padded);
    await expect(store.read(artifact.id, "map.svg")).resolves.toHaveProperty(
      "text",
      svg,
    );
    await expect(
      store.read(artifact.id, "manifest.json"),
    ).resolves.toHaveProperty("text", padded);
    await truncate(manifestPath, 100_001);
    await expect(store.read(artifact.id, "manifest.json")).rejects.toThrow(
      "Invalid artifact file",
    );
    await writeFile(manifestPath, original);
    await truncate(
      join(directory, artifact.id, "map.svg"),
      MAP_LIMITS.svgBytes + 1,
    );
    await expect(store.read(artifact.id, "map.svg")).rejects.toThrow(
      "Invalid artifact file",
    );
    await expect(
      store.put({ ...map, svg: svg + " " }, source),
    ).rejects.toThrow();
    expect(await readdir(directory)).toEqual([artifact.id]);
  }, 3000);

  it("serializes concurrent puts within capacity and recovers its queue after a rejected put", async () => {
    const initial = await store.put(map, source);
    const { text } = await store.read(initial.id, "manifest.json");
    const total = initial.bytes + Buffer.byteLength(text);
    store = new LocalMapArtifacts({ directory, now, maxBytes: total * 2 });
    let clock = epoch;
    now.mockImplementation(() => clock++);
    const rejected = expect(
      store.put({ ...map, svg: "x".repeat(total * 3) }, source),
    ).rejects.toMatchObject({ code: "MAP_STORAGE_LIMIT" });
    const artifacts = await Promise.all(
      Array.from({ length: 6 }, () => store.put(map, source)),
    );
    await rejected;
    expect(new Set(artifacts.map(({ id }) => id)).size).toBe(6);
    const survivors = artifacts.slice(-2);
    expect((await readdir(directory)).sort()).toEqual(
      survivors.map(({ id }) => id).sort(),
    );
    for (const artifact of survivors) {
      await expect(store.read(artifact.id, "map.svg")).resolves.toHaveProperty(
        "text",
        map.svg,
      );
      await expect(
        store.read(artifact.id, "manifest.json"),
      ).resolves.toHaveProperty("mimeType", "application/json");
    }
  });

  it("rejects over-capacity publication before evicting existing data", async () => {
    const artifact = await store.put(map, source);
    const { text } = await store.read(artifact.id, "manifest.json");
    store = new LocalMapArtifacts({
      directory,
      now,
      maxBytes: artifact.bytes + Buffer.byteLength(text) - 1,
    });
    await expect(store.put(map, source)).rejects.toMatchObject({
      code: "MAP_STORAGE_LIMIT",
    });
    expect(await readdir(directory)).toEqual([artifact.id]);
    await expect(store.read(artifact.id, "map.svg")).resolves.toHaveProperty(
      "text",
      map.svg,
    );
  });

  it("rejects manifests exceeding the read limit instead of publishing unreadable artifacts", async () => {
    await expect(
      store.put(map, { ...source, warning: "x".repeat(100_000) }),
    ).rejects.toThrow();
    expect(await readdir(directory)).toEqual([]);
  });

  it("rejects invalid retention and storage budgets at construction", () => {
    for (const value of [
      0,
      -1,
      0.5,
      NaN,
      Infinity,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      for (const option of ["retentionMs", "maxBytes"] as const) {
        expect(
          () => new LocalMapArtifacts({ directory, [option]: value }),
        ).toThrow(expect.objectContaining({ code: "MAP_STORAGE_INVALID" }));
      }
    }
  });
});
