import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { expect, it, vi } from "vitest";
import { createEveServer } from "../src/server.js";
import { OperationCatalog } from "../src/openapi.js";
import { EsiClient } from "../src/esi-client.js";
import { LocalMapArtifacts } from "../src/map-artifacts.js";
import { LocalMapPreview } from "../src/map-preview.js";
import { LocalMapDataSource } from "../src/map-data.js";
import { LocalMapStore } from "../src/map-store.js";
import { MapCatalog } from "../lib/src/cartography/catalog.js";
import { mapResultSchema } from "../lib/src/cartography/mcp.js";
import { LIGHT_YEAR_METRES } from "../lib/src/cartography/types.js";
import { fixtureDocument } from "./fixtures.js";
import { fixtureSource } from "./skill-fixtures.js";

it("wires a real SVG artifact and raster preview through the app without ESI, auth or skill planning", async () => {
  const directory = await mkdtemp(join(tmpdir(), "eve-map-integration-"));
  const fetchImplementation = vi.fn<typeof fetch>();
  const getAccessToken = vi.fn<() => Promise<string | undefined>>();
  const operations = new OperationCatalog(fixtureDocument());
  const esi = new EsiClient(
    operations,
    { getAccessToken },
    { fetchImplementation },
  );
  const catalog = new MapCatalog({
    schemaVersion: 1,
    buildNumber: 1,
    releaseDate: "2026-09-01T00:00:00Z",
    fetchedAt: "2026-09-02T00:00:00Z",
    sourceUrl: "https://example.invalid/synthetic-map",
    systems: [
      {
        id: 1,
        name: "Synthetic point",
        regionId: 1,
        constellationId: 1,
        position: { x: 0, y: 0, z: 0 },
        securityStatus: 0.95,
      },
    ],
    regions: [{ id: 1, name: "Synthetic region" }],
    constellations: [{ id: 1, regionId: 1, name: "Synthetic constellation" }],
    gates: [],
  });
  const source = {
    buildNumber: 1,
    releaseDate: catalog.data.releaseDate,
    fetchedAt: catalog.data.fetchedAt,
    sourceUrl: catalog.data.sourceUrl,
    checkedAt: catalog.data.fetchedAt,
    stale: false,
  };
  const skills = fixtureSource();
  const skillInitialize = vi.spyOn(skills, "initialize");
  const server = createEveServer(operations, esi, undefined, skills, {
    data: { initialize: () => Promise.resolve({ catalog, status: source }) },
    artifacts: new LocalMapArtifacts({ directory }),
    preview: new LocalMapPreview(),
  });
  const client = new Client({ name: "integration-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(b);
    await client.connect(a);
    expect(client.getInstructions()).toContain(
      "only to visualize an existing plan",
    );
    const result = await client.callTool({
      name: "render_eve_map",
      arguments: {
        boundary: { kind: "systems", systems: [1] },
        pointsOfInterest: [{ system: 1, label: "Caller-selected point" }],
      },
    });
    const parsed = mapResultSchema.parse(result.structuredContent);
    if (parsed.status !== "ready" && parsed.status !== "partial")
      throw new Error("Expected rendered artifact");
    expect(parsed.status).toBe("ready");
    expect(parsed.preview.status).toBe("ready");
    const image = result.content.find((block) => block.type === "image");
    expect(image?.type).toBe("image");
    if (image?.type !== "image") throw new Error("Expected image preview");
    expect(Buffer.from(image.data, "base64").subarray(0, 8)).toEqual(
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    );
    const resource = await client.readResource({ uri: parsed.artifact.uri });
    const svg = resource.contents[0];
    if (!svg || !("text" in svg)) throw new Error("Expected SVG resource text");
    expect(svg.mimeType).toBe("image/svg+xml");
    expect(createHash("sha256").update(svg.text).digest("hex")).toBe(
      parsed.artifact.sha256,
    );
    expect(svg.text).toContain("Caller-selected point");
    expect(fetchImplementation).not.toHaveBeenCalled();
    expect(getAccessToken).not.toHaveBeenCalled();
    expect(skillInitialize).not.toHaveBeenCalled();
  } finally {
    await Promise.all([client.close(), server.close()]);
    await rm(directory, { recursive: true, force: true });
  }
});

it("renders SQLite neighborhoods after publication and restart, retaining SVG when preview fails", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "eve-map-sqlite-integration-"),
  );
  const checkedAt = "2026-09-02T00:00:00.000Z";
  const fetchImplementation = vi.fn<typeof fetch>();
  const getAccessToken = vi.fn<() => Promise<string | undefined>>();
  const operations = new OperationCatalog(fixtureDocument());
  const esi = new EsiClient(
    operations,
    { getAccessToken },
    { fetchImplementation },
  );
  const options = {
    directory,
    fetchImplementation,
    now: () => Date.parse(checkedAt),
  };
  const data = new LocalMapDataSource(options);
  const catalog = new MapCatalog({
    schemaVersion: 1,
    buildNumber: 1,
    releaseDate: "2026-09-01T00:00:00Z",
    fetchedAt: checkedAt,
    sourceUrl:
      "https://developers.eveonline.com/static-data/tranquility/eve-online-static-data-1-jsonl.zip",
    systems: ["Incoming", "Center", "Outgoing", "Two-hop", "Unconnected"].map(
      (name, index) => ({
        id: index + 1,
        name,
        regionId: 1,
        constellationId: 1,
        position: {
          x: index * 4 * LIGHT_YEAR_METRES,
          y: 0,
          z: (index % 2) * 3 * LIGHT_YEAR_METRES,
        },
        position2D: { x: index * 4, y: (index % 2) * 3 },
        securityStatus: 0.95,
      }),
    ),
    regions: [{ id: 1, name: "Synthetic region" }],
    constellations: [{ id: 1, regionId: 1, name: "Synthetic constellation" }],
    gates: [
      { id: 10, systemId: 1, destinationId: 2, destinationGateId: 11 },
      { id: 12, systemId: 2, destinationId: 3, destinationGateId: 13 },
      { id: 14, systemId: 3, destinationId: 4, destinationGateId: 15 },
    ],
  });
  const prepare = vi.spyOn(LocalMapStore.prototype, "prepare");
  const loadCatalog = vi.spyOn(LocalMapStore.prototype, "loadCatalog");
  const skills = fixtureSource();
  const skillInitialize = vi.spyOn(skills, "initialize");
  let previousArtifact: { uri: string; sha256: string } | undefined;
  try {
    new LocalMapStore(directory).publish(catalog, {
      checkedAt,
      etag: null,
      archiveSha256: createHash("sha256")
        .update("synthetic archive")
        .digest("hex"),
    });
    for (const restarted of [false, true]) {
      const source = restarted ? new LocalMapDataSource(options) : data;
      const sourcePrepare = vi.spyOn(source, "prepare");
      const initialize = vi.spyOn(source, "initialize");
      const preview = new LocalMapPreview();
      const renderPreview = vi
        .spyOn(preview, "render")
        .mockRejectedValue(new Error("Synthetic rasterizer failure"));
      const server = createEveServer(operations, esi, undefined, skills, {
        data: source,
        artifacts: new LocalMapArtifacts({
          directory: join(directory, "artifacts"),
          now: options.now,
        }),
        preview,
      });
      const client = new Client({
        name: "sqlite-integration-test",
        version: "1",
      });
      const [a, b] = InMemoryTransport.createLinkedPair();
      try {
        await server.connect(b);
        await client.connect(a);
        expect(client.getInstructions()).toContain("kind:'neighborhood'");
        if (previousArtifact) {
          const resource = await client.readResource({
            uri: previousArtifact.uri,
          });
          const svg = resource.contents[0];
          if (!svg || !("text" in svg))
            throw new Error("Expected persisted SVG");
          expect(createHash("sha256").update(svg.text).digest("hex")).toBe(
            previousArtifact.sha256,
          );
        }
        const boundary = restarted
          ? { kind: "neighborhood", center: 2, jumps: 1 }
          : { kind: "neighborhood", center: "Center" };
        const result = await client.callTool({
          name: "render_eve_map",
          arguments: {
            boundary,
            pointsOfInterest: [],
            preview: restarted ? "none" : "png",
          },
        });
        expect(result.isError).not.toBe(true);
        const parsed = mapResultSchema.parse(result.structuredContent);
        if (parsed.status !== "ready" && parsed.status !== "partial")
          throw new Error("Expected rendered neighborhood");
        expect(parsed).toMatchObject({
          status: restarted ? "ready" : "partial",
          preview: { status: restarted ? "not_requested" : "failed" },
          summary: {
            systemCount: 3,
            edgeCount: 2,
            routes: [],
            pointsOfInterest: [],
          },
          completeness: { boundaryConnections: 1 },
          sources: { staticData: { buildNumber: 1, checkedAt, stale: false } },
        });
        expect(result.structuredContent).not.toHaveProperty("result");
        expect(result.content.some((block) => block.type === "image")).toBe(
          false,
        );
        expect(renderPreview).toHaveBeenCalledTimes(restarted ? 0 : 1);
        if (!restarted)
          expect(parsed.warnings).toContainEqual({
            code: "MAP_PREVIEW_UNAVAILABLE",
            message: expect.stringContaining("SVG is available"),
          });
        const resource = await client.readResource({
          uri: parsed.artifact.uri,
        });
        const svg = resource.contents[0];
        if (!svg || !("text" in svg))
          throw new Error("Expected SVG resource text");
        expect(svg.mimeType).toBe("image/svg+xml");
        expect(createHash("sha256").update(svg.text).digest("hex")).toBe(
          parsed.artifact.sha256,
        );
        for (const name of ["Incoming", "Center", "Outgoing"])
          expect(svg.text).toContain(name);
        for (const name of ["Two-hop", "Unconnected"])
          expect(svg.text).not.toContain(name);
        expect(sourcePrepare).toHaveBeenCalledOnce();
        expect(sourcePrepare).toHaveBeenCalledWith(
          expect.objectContaining({
            boundary: { ...boundary, jumps: 1 },
          }),
          expect.any(AbortSignal),
        );
        expect(initialize).not.toHaveBeenCalled();
        previousArtifact = parsed.artifact;
      } finally {
        await Promise.all([client.close(), server.close()]);
        sourcePrepare.mockRestore();
        initialize.mockRestore();
        renderPreview.mockRestore();
      }
    }
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(loadCatalog).not.toHaveBeenCalled();
    expect(fetchImplementation).not.toHaveBeenCalled();
    expect(getAccessToken).not.toHaveBeenCalled();
    expect(skillInitialize).not.toHaveBeenCalled();
  } finally {
    prepare.mockRestore();
    loadCatalog.mockRestore();
    skillInitialize.mockRestore();
    await rm(directory, { recursive: true, force: true });
  }
});
