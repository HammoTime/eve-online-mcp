# Render existing plans as SVG maps

`render_eve_map` is a renderer, **not a planning tool**. Other tools or the user
provide the boundary, points of interest and any already-ordered routes. The
renderer never chooses destinations, calculates paths, repairs missing links,
reorders visits, recommends activities or changes game state. It does not call
ESI or authenticate an EVE character. It reads cached public CCP SDE geography.

This supersedes the earlier proposed `generate_eve_map` interface: there are no
`from`, `to`, `via`, `avoid` or `preference` arguments. The explicit `neighborhood`
boundary selects one permanent-stargate hop; it is not a route planner.

## Input

Both `boundary` and `pointsOfInterest` are required. Pass an empty list when no
points are needed. All names are exact, case-insensitive and whitespace-trimmed,
within the requested category. Numeric values are IDs; numeric strings are names,
not implicitly converted IDs. Ambiguous/unknown names fail without selecting one.

```json
{
  "boundary": { "kind": "constellation", "constellation": "Kimotoro" },
  "pointsOfInterest": [
    {
      "system": "Jita",
      "kind": "staging",
      "label": "Departure",
      "note": "Caller-selected starting point."
    },
    {
      "system": "Maurasi",
      "kind": "waypoint",
      "label": "Supplied destination"
    }
  ],
  "routes": [
    { "label": "Supplied illustration", "systems": ["Jita", "Maurasi"] }
  ],
  "title": "Kimotoro / route illustration",
  "theme": "dark",
  "layout": "atlas",
  "size": "standard",
  "preview": "png"
}
```

This is a rendering example, not travel advice. Its permanent gate adjacency was
checked against SDE builds 3498825 and 3500372 during development, not against live route safety.

### Boundary variants

| Kind            | Additional fields                       | Meaning                                                                |
| --------------- | --------------------------------------- | ---------------------------------------------------------------------- |
| `systems`       | `systems: (string \| number)[]`         | Exactly these systems; no automatic neighbours                         |
| `neighborhood`  | `center: string \| number`, `jumps?: 1` | Center plus all incoming/outgoing one-hop permanent-stargate neighbors |
| `region`        | `region: string \| number`              | All SDE systems in this region                                         |
| `constellation` | `constellation: string \| number`       | All SDE systems in this constellation                                  |
| `extent`        | `minX`, `maxX`, `minZ`, `maxZ`          | Inclusive absolute X/Z bounds, in light years                          |

Extents require strictly increasing bounds and force geographic layout. +X is
right, +Z is up, and the Y coordinate is omitted. The viewport remains the supplied
extent; it is not refitted around points of interest. This is not a jump-range
calculation. A rounded visual frame marks the map panel; it is **not** a territorial
or sovereignty boundary.

For example, `{"boundary":{"kind":"neighborhood","center":"Jita","jumps":1},"pointsOfInterest":[]}`
needs one map call and no ESI lookup calls. `jumps` defaults to 1; other depths are
rejected. Incoming-only links are included without inventing reverse route hops.

POIs and every route visit must fall inside the explicit boundary. A mismatch
returns an error, never silent expansion. Bounds exceeding 250 systems are rejected
rather than partially rendering a region as if complete. Low-priority labels may
be omitted for legibility; their count and the number of external connections are
reported. Selected nodes and important labels are never silently dropped.

### Points of interest and routes

- Up to 12 POIs. Each has `system`, `label` (1-60 characters), optional `note`
  (1-160 characters), and `kind`: `activity` (default), `staging`, `waypoint`, or
  `warning`. The numbered list is included in the SVG, with corresponding markers.
- Up to 3 supplied routes of 1-100 visits each. Each route has an ordered `systems`
  list and optional `label`. Only adjacent directed permanent-gate hops are accepted.
- Repeated nonconsecutive system visits and caller route order are retained. A
  nonexistent connection is rejected; no path is calculated to fill the gap.
- A repeated _consecutive_ system is not a gate hop and is rejected. A single-system
  route is valid and has zero jumps.
- Geometry or full POI text that cannot fit at readable size returns `MAP_TOO_DENSE`.
  Input count limits are ceilings, not a promise every maximum-sized composition fits.

### Styling

- `theme`: `dark` (default) or `light`.
- `layout`: `atlas` (default) or `geographic`. Atlas uses SDE `position2D` if present
  for every selected system, otherwise whole-view X/Z. Deterministic collision
  separation is capped at 24 SVG pixels and disclosed. Geographic coordinates never
  move. Coincident nodes that cannot be displayed honestly fail explicitly.
- `size`: `standard` (1440 x 900, default) or `wide` (1600 x 900).
- `title`: optional, at most 100 characters.
- `preview`: `png` (default) or `none`.

The visual style uses circular nodes, thin gate links, round route strokes, restrained
halos, clear labels and a framed POI rail. Arrows, route identifiers and endpoint
rings supplement colour. Text uses natural font proportions and spacing, never
`textLength`, glyph scaling or forced tracking to fit. Conservative width estimates
are used only for wrapping and collision bounds. Numbered markers use centered text
anchors, and the SVG preserves its aspect ratio when resized. DejaVu Sans is preferred
to match the bundled PNG font, with standard sans-serif fallbacks in other viewers.
Security is shown approximately to two decimal places;
full raw values remain in SVG tooltips. **No safety classification is inferred from
raw rounding.** All route and activity labels are caller annotations.

## Output and inline display

The primary output is a self-contained `image/svg+xml` artifact. The result includes:

- A resource link such as `eve-map://artifacts/<opaque-id>/map.svg`.
- A PNG image content block when preview rasterization succeeds.
- Structured scope/route/POI summaries, layout metadata, completeness and warnings.
- SDE build, release/fetch/check timestamps and stale status.
- SVG dimensions, byte count, SHA-256, manifest URI and expiration.

`resources/read` retrieves SVG as UTF-8 text or its JSON manifest. Custom MCP URIs
are **not browser URLs**. They work without assuming the client sees the server's
container filesystem. No public upload, browser server, external asset or arbitrary
output path is involved. Older negotiated protocol versions get an embedded SVG
resource instead of a resource-link block.

PNG is generated from the exact saved SVG using a lazy local resvg adapter and
bundled DejaVu fonts; the renderer is not implemented twice. Native-preview failure
or capacity exhaustion preserves the valid SVG and returns `partial` with a warning.
SVG viewers may use different fallback fonts; Unicode glyph support depends on the
viewer/font. The PNG adapter uses the bundled font's coverage, not every Unicode font.

MCP does not guarantee inline display in every coding host. A PNG-capable host can
display the preview; an SVG-capable host can open the vector resource; a text-only
host still receives a resource and summary. Automated MCP tests and native image
checks pass, and dark/light images have been visually inspected. Actual tool-inline
rendering in OpenCode, Codex and VS Code Copilot has **not** been certified by these
tests. Do not report image display as successful solely because a tool call succeeded.

## Storage, limits and privacy

The stdio application supplies the adapters; shared consumers get the tool only
when `createEveServer` receives `cartography` services. Registration does not download
the SDE or load the native rasterizer. No hosted deployment is part of this change.

Map SDE initializes lazily, checks the fixed CCP manifest at five-minute intervals,
and uses `maps-v1.sqlite` in the existing SDE directory (`EVE_SDE_CACHE_DIR`
override). It initially downloads the official ZIP independently of the skill cache;
new downloads are temporary rather than accumulating archived builds. Existing
`map-catalog-v1.json` migrates only after its checksum, build identity, complete graph,
and matching build-and-digest ZIP are validated. Legacy files are left untouched.

Normal map requests use indexed name/boundary/connection reads in one SQLite read
transaction, not a full-catalog reload. Full graph validation happens before atomic
publication. A slower older download or freshness check cannot overwrite a newer
snapshot. Failed refresh retains a labelled last-good snapshot and cannot break skill
planning. The compatibility `initialize()` method used by offline scripts still
loads a full catalog; MCP uses `prepare()` instead. See [local storage](local-storage.md).

Generated SVG/manifest artifacts default to a `maps` directory beneath the SDE cache;
override with **`EVE_MAP_ARTIFACT_DIR`** in the server environment. They expire after
seven days and are evicted oldest-created-first to respect the 100 MB generated-store
budget. Reads persist across restarts but cannot promise retention for an exported
link indefinitely. Only recognized generated artifacts are cleaned; this is not a
general file-management API. A future multi-user adapter must authorize every read
against an owner; opaque IDs and content hashes alone are not access control.

The tool has `readOnlyHint: false` because it writes local derived files; it never
changes the game. Do not infer public sharing permission from public base geography:
annotations and travel plans may be sensitive. Telemetry omits requested routes,
notes, SVG/PNG contents and artifact handles. Such diagnostic captures are partial,
not fully replayable. stdout remains reserved for MCP protocol traffic.

Budgets: 250 selected systems, 100 visits per route, 3 routes, 12 POIs, 1 MB SVG,
1.5 MB PNG before base64, and 5 MB serialized MCP result. Preview dimensions may be
reduced once to meet byte limits, but never at the expense of the primary SVG. At
most two native previews execute concurrently per adapter. The renderer uses fixed
iteration bounds and returns explicit density errors instead of running an unbounded
force simulation. SVG serialization escapes all data and emits only built-in elements
and internal fragment references, with no scripts, external resources or raw markup.

## Development and verification

Run commands in the devcontainer, including:

```sh
npm run maps:example          # offline synthetic visual fixtures
npm run maps:example -- --live # public CCP SDE, explicit Kimotoro example
npm run maps:example -- --live --output-dir .. # previews in the parent workspace
npm run validate
npm pack --dry-run
```

Examples are written below ignored `artifacts/cartography/`; they are not packaged.
Run the library's `npm run validate` separately in its devcontainer as well. Tests
cover strict renderer-only schema, no route repair, boundary enforcement, directed
adjacency, stale/corrupt caches, deterministic geometry, escaped text, POI overflow,
artifact hashing/retention/symlink safety, real PNG output and mixed MCP delivery.
