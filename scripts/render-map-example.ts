import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MapCatalog } from "../lib/src/cartography/catalog.js";
import { renderMap } from "../lib/src/cartography/render.js";
import {
  mapRequestSchema,
  type MapData,
} from "../lib/src/cartography/types.js";
import { LocalMapDataSource } from "../src/map-data.js";
import { LocalMapPreview } from "../src/map-preview.js";

// Development-only sample. --live downloads public CCP SDE; it never calls a planner.
const live = process.argv.includes("--live");
const outputIndex = process.argv.indexOf("--output-dir");
const output =
  outputIndex < 0
    ? join("artifacts", "cartography")
    : process.argv[outputIndex + 1];
if (!output || output.startsWith("--"))
  throw new Error("--output-dir requires a directory");
await mkdir(output, { recursive: true });
const fixture: MapData = {
  schemaVersion: 1,
  buildNumber: 1,
  releaseDate: "2026-09-09T00:00:00Z",
  fetchedAt: "2026-09-09T00:00:00Z",
  sourceUrl: "https://example.invalid/synthetic-map-fixture",
  regions: [{ id: 1, name: "Synthetic region" }],
  constellations: [{ id: 1, name: "Synthetic constellation", regionId: 1 }],
  systems: [
    { id: 1, name: "Alpha", position: { x: 0, y: 0, z: 0 } },
    { id: 2, name: "Beta", position: { x: 30, y: 0, z: 20 } },
    { id: 3, name: "Gamma", position: { x: 70, y: 0, z: 10 } },
    { id: 4, name: "Delta", position: { x: 55, y: 0, z: 50 } },
  ].map((system) => ({
    ...system,
    regionId: 1,
    constellationId: 1,
    securityStatus: 0.9459131360054016,
  })),
  gates: (
    [
      [1, 2],
      [2, 3],
      [2, 4],
    ] as const
  ).flatMap(([a, b], index) => [
    {
      id: index * 2 + 1,
      systemId: a,
      destinationId: b,
      destinationGateId: index * 2 + 2,
    },
    {
      id: index * 2 + 2,
      systemId: b,
      destinationId: a,
      destinationGateId: index * 2 + 1,
    },
  ]),
};
const { catalog } = live
  ? await new LocalMapDataSource({
      directory: join("artifacts", "cartography", "sde"),
    }).initialize()
  : { catalog: new MapCatalog(fixture) };
for (const theme of ["dark", "light"] as const) {
  const request = mapRequestSchema.parse(
    live
      ? {
          boundary: { kind: "constellation", constellation: "Kimotoro" },
          pointsOfInterest: [
            {
              system: "Jita",
              kind: "staging",
              label: "Departure",
              note: "Caller-selected starting point.",
            },
            {
              system: "Maurasi",
              kind: "waypoint",
              label: "Supplied destination",
            },
          ],
          routes: [
            { label: "Supplied illustration", systems: ["Jita", "Maurasi"] },
          ],
          title: "Kimotoro / route illustration",
          theme,
        }
      : {
          boundary: { kind: "constellation", constellation: 1 },
          pointsOfInterest: [
            {
              system: "Alpha",
              kind: "staging",
              label: "Departure",
              note: "Synthetic visual fixture, not an EVE route.",
            },
            {
              system: "Gamma",
              kind: "activity",
              label: "Existing plan destination",
              note: "The renderer does not recommend activities.",
            },
          ],
          routes: [{ label: "Already-planned path", systems: [1, 2, 3] }],
          title: "Stellar atlas / synthetic example",
          theme,
        },
  );
  const map = renderMap(catalog, request);
  const png = await new LocalMapPreview().render(
    map.svg,
    map.width,
    new AbortController().signal,
  );
  const name = `${live ? "kimotoro" : "synthetic"}-${theme}`;
  await writeFile(join(output, `${name}.svg`), map.svg);
  await writeFile(join(output, `${name}.png`), Buffer.from(png.data, "base64"));
  console.error(
    JSON.stringify({
      name,
      ...map.summary,
      warnings: map.warnings,
      svgBytes: Buffer.byteLength(map.svg),
      pngBytes: png.bytes,
    }),
  );
}
