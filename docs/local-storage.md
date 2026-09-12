# Local SQLite storage

The npx/stdio server requires Node 22.13.0 or newer and uses `node:sqlite`.
SQLite runs inside the server process; there is no service, CLI installation,
native database npm dependency, or move of credentials into SQLite.

## Stored data

Both databases live in the existing OS SDE cache directory, overridden by
`EVE_SDE_CACHE_DIR`:

| File               | Contents and access                                                                                                                                                                      |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `skills-v1.sqlite` | Schema version 2: normalized public types, ordered prerequisites, name indexes, counts and checksummed build metadata. Planning queries a request snapshot.                              |
| `maps-v1.sqlite`   | Public validated universe projection, name indexes, directed gate-pair counts, build/check metadata, and a separate compatibility catalog. Normal MCP requests read selected facts only. |
| `sde-archives-v1/` | Small SQLite ownership index and two bounded ZIP slots shared by independent skill/map imports. Not queried for gameplay facts.                                                          |

SQLite may create `-wal` and `-shm` sidecars. Keep the directory on a local
filesystem supporting SQLite locks and WAL, not a network share or live
cloud-synchronization folder. Container users should mount a persistent local
volume. Do not copy a live database without its transaction state; stop the
servers before copying the database and any sidecars together.

Credentials remain in the existing permission-protected plaintext credential
store, outside these public caches. Access tokens and ESI response caches remain
in memory. Private map annotations and generated SVG/manifest files retain their
existing filesystem artifact store and seven-day/100 MB limits. SQLite is not
encryption and does not add Windows ACL guarantees.

The credential JSON file gains non-secret generation IDs under its existing lock.
Refresh and cached-token return recheck that generation, identity and scopes, so
logout/reconnect cannot be overwritten by an older operation. Legacy credentials
are upgraded without moving their tokens into public storage.

## Migration and failure

- With no database, a valid `catalog-v1.json` migrates into the skill database.
- A recognized 0.8.0 skill database is checksum-validated and transactionally
  migrated from its JSON blob to normalized schema version 2 at the same path.
  Conversion failure leaves the old database intact. Older 0.8.0 processes reject
  the newer schema rather than competing with it; stop older servers when upgrading.
- With no map database, a valid `map-catalog-v1.json` migrates after its catalog
  checksum, full graph, trusted build URL, and matching immutable ZIP hash pass.
- Legacy JSON and ZIP files are left untouched. They are not updated after migration.
- An existing corrupt, incomplete, or unsupported database fails closed. It is
  never deleted automatically or replaced using an older legacy cache.
- Download/validation/publication failures preserve usable last-good state with
  explicit stale warnings. No missing graph is represented as empty facts.
- Skills and maps reuse a complete, hashed archive, including a later first map
  request or a server restart. Projection validation/publication stays independent:
  a map parsing failure cannot replace a usable skill projection, or vice versa.
- The archive cache retains at most two 256,000,000-byte reservations (512 MB
  total owned ZIP bytes), including partial downloads. Its index is limited to
  16 4,096-byte pages plus a rollback journal. Legacy files are outside this bound.
- Reservations and readers are never reclaimed merely by age. A crash or failed
  release can exhaust capacity; recovery requires stopping all users and choosing
  a new cache directory, not deleting files that might still be open. A complete
  but invalid same-build archive remains cached and does not trigger endless retries.

For an unavailable or incompatible cache, inspect directory permissions, free
space, runtime version, and filesystem support first. To rebuild without deleting
evidence, stop all servers and configure a new empty `EVE_SDE_CACHE_DIR`, then
restart. This downloads public CCP data again. Keep credentials and map artifacts
separate; changing the cache directory also changes the default artifact directory
unless `EVE_MAP_ARTIFACT_DIR` is set. Packages predating SQLite still use retained
legacy files; 0.8.0 recognizes only its original skill database schema.

## Concurrency and performance

Map connections are scoped to synchronous operations. Each skill initialization
acquires its own read snapshot, released in `finally` after resolution/planning;
the startup warmup releases immediately. Abandoned snapshots expire after three
minutes, and operations against expired readers fail rather than mixing builds.
Writers use
WAL, full synchronous durability, a five-second lock wait, and short
`BEGIN IMMEDIATE` transactions. No download or archive parse holds the publication
lock. Publication compares build identity, and freshness updates are fenced against
the saved generation/digest. An older writer cannot replace a newer build or attach
its ETag to that newer build. Busy/disk failures are not success and do not silently
advance freshness.

Skill acquisition checks schema, metadata checksum and table counts. Individual
lookups validate bounded row text, its digest and prerequisite counts/values;
status does not reread every type. Names use stored JavaScript lowercase keys,
not SQLite's ASCII-only case folding. Exact lookups are indexed; substring
suggestions are bounded SQL scans, not a claim of constant-cost full-text search.
The request-local lookup cache is limited to 10,000 types. No normal status,
refresh, target resolution or planning path deserializes the whole catalog.

New skill imports stage decoded JSONL rows on disk in batches of at most 256 and
derive the selected projection there. They do not accumulate every raw type and
dogma row in JavaScript. Bounded conversion of older JSON/blob formats and explicit
compatibility exports remain exceptional full-catalog operations.

Map preparation resolves names globally, including ambiguity, then selects an exact
boundary through indexes and reads only its touching gate pairs. One read transaction
keeps all facts on the same snapshot even if another process publishes. Boundaries
over 250 systems fail without trimming. Direction, parallel gates, incoming-only
neighbors, and distinct external connections retain the shared renderer's semantics.
No per-system ESI requests or authenticated calls are needed for geography.

The compatibility map catalog is used only by explicit `initialize()` callers and
offline scripts, never by normal `render_eve_map` preparation. First import still
validates a complete graph in memory and runs synchronous SQLite writes; it is not
a streaming-memory or event-loop-latency guarantee. SQLite improves map request
data access and cross-process publication, not upstream ESI latency, model tool
selection or client inline rendering. CCP's SDE remains the upstream source;
SQLite replaces runtime catalog management, not the upstream data itself.

Query-only local skill diagnostics are labelled partial with
`catalog_artifact_unavailable`, rather than reconstructing a full catalog or
exporting a private character's lookup footprint. Existing complete catalog
artifacts and in-memory replay adapters remain supported. A failed static-data
initialization is also partial (`static_catalog_unavailable`), never exact without
its dependency evidence.

Automated checks compare SQLite maps with the full-catalog renderer across boundary
types, inspect indexed query plans, and cover migration, restart, stale writers,
rollback, corruption, cancellation, and local MCP output contracts. They are not a
real-archive benchmark or certification of every Windows/macOS filesystem.
