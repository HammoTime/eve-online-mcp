# Local SQLite storage

The npx/stdio server requires Node 22.13.0 or newer and uses `node:sqlite`.
SQLite runs inside the server process; there is no service, CLI installation,
native database npm dependency, or credential migration.

## Stored data

Both databases live in the existing OS SDE cache directory, overridden by
`EVE_SDE_CACHE_DIR`:

| File               | Contents and access                                                                                                                                                                      |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `skills-v1.sqlite` | Public, checksum-validated skill/ship catalog and build/check metadata. Planning still uses an in-memory `SkillCatalog`.                                                                 |
| `maps-v1.sqlite`   | Public validated universe projection, name indexes, directed gate-pair counts, build/check metadata, and a separate compatibility catalog. Normal MCP requests read selected facts only. |

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

## Migration and failure

- With no database, a valid `catalog-v1.json` migrates into the skill database.
- With no map database, a valid `map-catalog-v1.json` migrates after its catalog
  checksum, full graph, trusted build URL, and matching immutable ZIP hash pass.
- Legacy JSON and ZIP files are left untouched. They are not updated after migration.
- An existing corrupt, incomplete, or unsupported database fails closed. It is
  never deleted automatically or replaced using an older legacy cache.
- Download/validation/publication failures preserve usable last-good state with
  explicit stale warnings. No missing graph is represented as empty facts.
- New ZIP downloads are temporary. Publication retains validated derived data,
  not another permanent archive. Skill and map cold imports remain independent.

For an unavailable or incompatible cache, inspect directory permissions, free
space, runtime version, and filesystem support first. To rebuild without deleting
evidence, stop all servers and configure a new empty `EVE_SDE_CACHE_DIR`, then
restart. This downloads public CCP data again. Keep credentials and map artifacts
separate; changing the cache directory also changes the default artifact directory
unless `EVE_MAP_ARTIFACT_DIR` is set. An older package still uses the retained legacy
files; it will not read the newer SQLite cache.

## Concurrency and performance

Connections are scoped to synchronous operations and closed afterward. Writers use
WAL, full synchronous durability, a five-second lock wait, and short
`BEGIN IMMEDIATE` transactions. No download or archive parse holds the publication
lock. Publication compares build identity, and freshness updates are fenced against
the saved generation/digest. An older writer cannot replace a newer build or attach
its ETag to that newer build. Busy/disk failures are not success and do not silently
advance freshness.

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
selection, client inline rendering, or the skill planner's in-memory API.

Automated checks compare SQLite maps with the full-catalog renderer across boundary
types, inspect indexed query plans, and cover migration, restart, stale writers,
rollback, corruption, cancellation, and local MCP output contracts. They are not a
real-archive benchmark or certification of every Windows/macOS filesystem.
