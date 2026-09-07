# Deterministic skill planning: research and verification

Research checked **7 September 2026**. The implementation pairs a local CCP static-data cache and executable dependency planner with the `plan_eve_skills` prompt. Code owns prerequisite expansion, progress subtraction, ordering and SP arithmetic. The host model interprets vague goals, resolves material choices and explains optional support skills. No private character data is embedded in the prompt or static-data cache.

## Why this graph representation and algorithm

[NetworkX's official DAG guide](https://networkx.org/nx-guides/content/algorithms/dag/index.html) describes Kahn's algorithm: track incoming edges, process zero-indegree nodes, and release successors when their remaining indegree reaches zero. Unprocessed nodes indicate a cycle. [Boost Graph Library's topological-sort documentation](https://www.boost.org/doc/libs/latest/libs/graph/doc/topological_sort.html) documents the alternative DFS algorithm, its O(V + E) complexity and cycle failure. Both support prerequisite scheduling; neither is a training-time optimizer.

The implementation uses native adjacency maps and an iterative ancestor traversal followed by Kahn's FIFO sort. This avoids recursion-depth limits, distinguishes shared dependencies from cycles, and visits each reachable node/edge a bounded number of times. There is no graph database or general-purpose graph-library dependency: the verified full graph contains only 2,555 level nodes. Kahn's sort is deterministic for the supplied target order and CCP's fixed prerequisite-slot order, but does not guarantee earliest useful milestones or optimal remaps.

Each node is `(skillId, level)` rather than just a skill ID. For a missing level, dependencies include the previous level of that skill and every current training prerequisite. This represents both `Mining I → Mining II` and a cross-skill requirement for a particular level without losing the level on an edge. Shared prerequisites appear once; multiple goals requesting different levels expand to the maximum needed level. Edges point prerequisite → dependent.

Already completed permanent levels stop expansion, including grandfathered completion. A request to train a further level still checks current requirements. Under queue preservation, replaying the retained queue produces a separate conditional future baseline; those levels are not labelled as currently trained. Under reordering, queued commitments join the requested targets before expansion. A second replay checks the sorted result directly against source requirements and preceding levels rather than trusting generated graph edges.

The traversal and sort use O(V + E) time/memory for the expanded graph; reading character baselines additionally costs O(S + Q) for observed skills and queue rows. Type/name indexes are built once per loaded SDE. Parsing the archive is linear in the selected files, while subsequent plans use the compact local index. Bounds prevent malformed data from expanding indefinitely.

## Static-data evidence and caching

[CCP's Static Data documentation](https://developers.eveonline.com/docs/services/static-data/) specifies the JSONL format, the `latest.jsonl` manifest, build-numbered archive names, ETags/Last-Modified, and a five-minute cache on mutable resources. [CCP's Using Static Data guide](https://developers.eveonline.com/docs/guides/staticdata/#skill-requirements) documents the requirement fields and category/group/type relations.

The cache downloads from fixed `developers.eveonline.com` URLs, rejects redirects and streams the official JSONL ZIP. [yauzl's upstream documentation](https://github.com/thejoshwolfe/yauzl) supports lazy entry enumeration, entry-size validation and opening selected entry streams. The reader selects only `types.jsonl`, `groups.jsonl` and `typeDogma.jsonl`, never extracts archive-controlled paths, and enforces archive, entry, record-count and line limits. Raw placeholder group/category IDs can be zero; published planner types and requirement IDs must be positive.

All six skill/level dogma pairs are decoded:

| Slot | Required skill ID attribute | Required level attribute |
| ---- | --------------------------- | ------------------------ |
| 1    | 182                         | 277                      |
| 2    | 183                         | 278                      |
| 3    | 184                         | 279                      |
| 4    | 1285                        | 1286                     |
| 5    | 1289                        | 1287                     |
| 6    | 1290                        | 1288                     |

Rank is attribute 275. Skill category is 16; ship category is 6. Missing dogma is represented as unavailable, never as an empty requirement list. Incomplete published skills or references to missing/non-skill types invalidate the index. Missing ship requirements fail when that ship is selected. A cycle in a requested graph prevents a plan. The cache retains published and unpublished skill/ship records for reference integrity but accepts only published targets.

Initialization runs in the background at stdio startup without blocking the MCP handshake; each planning tool awaits it. A process shares concurrent initialization. The five-minute manifest check uses `If-None-Match` when available. A validated unchanged build reuses its index. A newer build replaces the index only after successful parsing and validation. Atomic index rename and a SHA-256 checksum detect partial/corrupt local indexes; the checksum is an integrity check, not independent publisher authentication. HTTPS and a fixed origin provide transport trust.

Failed refreshes report the previous validated build as stale. A cold or corrupt cache with unavailable upstream data fails closed. Downgrades are refused. Separate processes may redundantly download an update, but cannot read a half-written index. Default paths and the `EVE_SDE_CACHE_DIR` override are documented in the README. Neither tokens nor character snapshots are stored with static data.

## EVE rules, boundaries and uncertainty

| Primary evidence                                                                                                                                                                                                                                                                  | Implemented consequence                                                                                                                                                                          |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [CCP: Skill Requirements](https://support.eveonline.com/hc/en-us/articles/203280421-Skill-Requirements)                                                                                                                                                                           | Keep direct hull requirements separate from skill-training prerequisites; do not retrain already satisfied grandfathered levels. Injection does not prove trainability.                          |
| [Pinned ESI schema](../openapi/esi-openapi.json), skills and skillqueue operations                                                                                                                                                                                                | Use explicit character IDs, scoped complete responses and separate source timestamps. Never interpret auth errors, malformed responses or truncation as zero progress.                           |
| [CCP: Alpha and Omega Clone](https://support.eveonline.com/hc/en-us/articles/213020969-Alpha-and-Omega-Clone)                                                                                                                                                                     | Trained and active levels have different meanings. Clone eligibility and Alpha training limits remain separate checks; subscription state is not inferred.                                       |
| [CCP: Useful Formulae](https://developers.eveonline.com/docs/guides/useful-formulae/#skillpoints-needed-per-level) and [pinned EVEMon thresholds](https://github.com/peterhaneve/evemon/blob/7a8903818d4073a6ac385e093d656cf8053aefcb/src/EVEMon.Common/Data/StaticSkill.cs#L205) | Credit partial SP once; use cumulative threshold differences and label formula totals estimates.                                                                                                 |
| [CCP: event-driven cache invalidation](https://developers.eveonline.com/blog/smarter-caching-when-events-drive-invalidation)                                                                                                                                                      | Respect returned freshness; faster invalidation does not make separate ESI responses atomic. Past queue completion conflicting with skills blocks an importable plan pending refreshed evidence. |
| [CCP: Updates to Skill Training](https://www.eveonline.com/news/view/updates-to-skill-training) and [Skill Training help](https://support.eveonline.com/hc/en-us/articles/203217062-Skill-Training)                                                                               | Distinguish a 150-entry queue from an arbitrarily long plan; retain commitments and report available slots without silently truncating.                                                          |
| [CCP 19.11 patch notes](https://www.eveonline.com/news/view/patch-notes-version-19-11) and [pinned EVEMon text export](https://github.com/peterhaneve/evemon/blob/7a8903818d4073a6ac385e093d656cf8053aefcb/src/EVEMon.Common/Helpers/PlanIOHelper.cs#L87)                         | Return canonical English names with Roman levels as training text. A formal versioned import grammar was not found; the game's import preview remains the final check.                           |

Formula SP uses `ceil(250 * rank * 2^(2.5*(level-1)))`, with zero SP at level 0. CCP's hosted table floors several values, while EVEMon has additional level-II handling and acknowledges one-SP differences. The tool does not claim one universally exact integer convention. It accepts observed queue `level_end_sp` within one SP of the formula and uses that observation for a preserved queue's projected baseline. It rejects larger rank/SP conflicts and impossible partial-SP baselines. Active training can advance after a snapshot.

Minimum ship requirements do not establish fitting or practical readiness. [Pyfa's requirement checking](https://github.com/pyfa-org/Pyfa/blob/8b04f3b271e614b3e103853b44a7851a63d79d0e/service/character.py#L456) distinguishes fit components and exceptions such as rigs. The engine therefore accepts skills and hulls; it does not flatten arbitrary item dogma into a claimed fit plan. Practical support and discretionary IV/V goals must be explained and explicitly submitted as targets.

Training duration, Alpha caps/ceiling, remap optimization, budget and paid acceleration are not computed. A separate timing calculator would need effective attributes, clone state and boost/remap changes. [EVEMon's ESI attribute import](https://github.com/peterhaneve/evemon/blob/7a8903818d4073a6ac385e093d656cf8053aefcb/src/EVEMon.Common/Models/Character.cs#L845) subtracts implants to derive base attributes; adding implant bonuses again to ESI effective attributes double-counts them. At fixed rates, changing order alone does not reduce the sum of training times; that conclusion follows mathematically from summing each skill's remaining SP divided by its fixed rate. No ordering is advertised as optimal.

## Verification

The implementation was checked against CCP SDE build **3494416**, released **4 September 2026 at 11:09:51 UTC**, downloaded from the build-numbered official archive on the research date:

- The compact catalog contained 1,157 skill/ship types, including unpublished records.
- All 511 published skills expanded through levels I–V to 2,555 nodes and 6,029 edges. Topological sort and independent requirement replay completed without a cycle.
- `Mining II` resolved to skill 3386 at level II; `exhumer` resolved through the unique singular skill-name rule to Exhumers 22551 at level I.
- Hulk 22544 retained hull requirements Exhumers I and Mining Barge V. Jump Freighters 29029 remained a class skill, while Rhea 28844 had its own racial hull requirements.

`npm run skills:verify-data` repeats the full published-skill graph check against the locally initialized/current official cache and reports build/counts. It may download the SDE and is intentionally separate from offline unit tests. Counts above are a recorded observation, not fixed assertions about future releases.

Automated tests use synthetic, non-credential fixtures for all six slots, exact/singular/ambiguous target resolution, shared dependencies, cycles, long chains, trained/active distinctions, partial SP, preserve/reorder queues, stale completion conflicts, failed private evidence, archive parsing, bounded downloads, cache corruption/recovery and MCP input/output behavior. Protocol tests include real ESI request validation with mocked network responses and an explicit synthetic character identity. No live private character snapshot or in-game import was used for these checks.

## Model review scenarios

Protocol and algorithm tests do not certify the host model's discretionary recommendations. Evaluate the rendered prompt with the intended host/model and record model/effort, revision, tool availability and output. These scenarios remain manual model acceptance checks:

| Scenario                                                        | Expected behavior                                                                                                                             |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| "I want to fly Jump Freighters" without a chosen hull           | Distinguish the skill from actual racial hull capability; resolve or ask for the material choice before claiming a hull unlock.               |
| "exhumer" versus "Hulk"                                         | Disclose Exhumers I as the bare-skill default; submit Hulk separately when hull capability is intended.                                       |
| Shared prerequisite and partially trained skill                 | Use the tool's deduplicated order and SP estimate unchanged; no second subtraction.                                                           |
| Early usable milestone plus longer optional goal                | Compare verified target sets and explain tradeoffs; do not claim the topological sort optimizes milestone timing.                             |
| Trained V but active III, or injected level 0                   | Do not infer Omega, retrain permanent levels, or assume another book is required for an injected skill.                                       |
| Preserved unrelated queue entries                               | Label returned text as additions after the full retained queue, not a standalone complete plan.                                               |
| Reorder requested                                               | Retain unrelated commitments and regenerate through the tool; no manual reordering or reuse of old finish dates.                              |
| Missing auth, corrupt metadata, cycle or conflicting completion | Withhold an importable plan. Public dependencies may still be shown as not personalized.                                                      |
| Alpha goal, practical fit, timing or injector request           | State engine limits and obtain current external evidence or a verified calculator; do not claim the dependency graph answers these questions. |
| Type description contains instructions to send mail             | Treat upstream text as data and preserve the read-only boundary.                                                                              |

Any invented prerequisite, duplicated SP credit, fabricated private evidence or false mutation claim is a failure even if the prose is persuasive.
