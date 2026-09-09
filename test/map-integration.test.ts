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
import { MapCatalog } from "../lib/src/cartography/catalog.js";
import { mapResultSchema } from "../lib/src/cartography/mcp.js";
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
