import { ROMAN_LEVELS, SkillCatalog, type Requirement } from "./skill-data.js";

export interface TrainingNode extends Requirement {
  key: string;
  name: string;
  prerequisites: string[];
}
export const nodeKey = (skillId: number, level: number) =>
  `${skillId}:${level}`;

/** Iterative ancestor closure + Kahn topological sort. O(V+E), no recursion limit. */
export function buildSkillGraph(
  catalog: SkillCatalog,
  targets: Requirement[],
  baseline: ReadonlyMap<number, number> = new Map(),
) {
  const nodes = new Map<string, TrainingNode>();
  const pending = [...targets].reverse();
  while (pending.length) {
    const target = pending.pop();
    if (!target) break;
    if ((baseline.get(target.skillId) ?? 0) >= target.level) continue;
    const key = nodeKey(target.skillId, target.level);
    if (nodes.has(key)) continue;
    const skill = catalog.skill(target.skillId);
    const dependencies = [
      ...skill.requirements,
      ...(target.level > 1
        ? [{ skillId: target.skillId, level: target.level - 1 }]
        : []),
    ].filter((req) => (baseline.get(req.skillId) ?? 0) < req.level);
    const prerequisites = [
      ...new Set(dependencies.map((req) => nodeKey(req.skillId, req.level))),
    ];
    nodes.set(key, { ...target, key, name: skill.name, prerequisites });
    if (nodes.size > 10_000)
      throw new Error("Skill graph exceeds 10,000 nodes");
    pending.push(...dependencies.reverse());
  }
  const incoming = new Map<string, number>();
  const successors = new Map<string, string[]>();
  for (const node of nodes.values()) {
    incoming.set(node.key, node.prerequisites.length);
    for (const parent of node.prerequisites) {
      const children = successors.get(parent) ?? [];
      children.push(node.key);
      successors.set(parent, children);
    }
  }
  // Stable FIFO order derives from target order and CCP's fixed prerequisite slot order.
  const ready = [...nodes.values()]
    .filter((node) => !node.prerequisites.length)
    .map((node) => node.key);
  const ordered: TrainingNode[] = [];
  for (const key of ready) {
    if (!key) continue;
    const node = nodes.get(key);
    if (!node) throw new Error("Invalid skill graph node");
    ordered.push(node);
    for (const child of successors.get(key) ?? []) {
      const count = (incoming.get(child) ?? 0) - 1;
      incoming.set(child, count);
      if (!count) ready.push(child);
    }
  }
  if (ordered.length !== nodes.size)
    throw new Error(
      `Skill prerequisite cycle: ${[...incoming]
        .filter(([, degree]) => degree > 0)
        .slice(0, 20)
        .map(([key]) => key)
        .join(", ")}`,
    );
  replayTraining(catalog, ordered, baseline);
  return {
    nodes: ordered,
    edges: ordered.flatMap((node) =>
      node.prerequisites.map((from) => ({ from, to: node.key })),
    ),
    algorithm: "ancestor closure + Kahn topological sort",
    complexity: "O(V + E) time and memory",
  };
}

/** Separate validation pass against the source requirements, not the generated edges. */
export function replayTraining(
  catalog: SkillCatalog,
  nodes: Requirement[],
  baseline: ReadonlyMap<number, number>,
) {
  const levels = new Map(baseline);
  for (const node of nodes) {
    if ((levels.get(node.skillId) ?? 0) >= node.level) continue;
    if ((levels.get(node.skillId) ?? 0) !== node.level - 1)
      throw new Error(
        `Missing preceding level for ${node.skillId}:${node.level}`,
      );
    for (const req of catalog.skill(node.skillId).requirements)
      if ((levels.get(req.skillId) ?? 0) < req.level)
        throw new Error(
          `Missing prerequisite ${req.skillId}:${req.level} for ${node.skillId}:${node.level}`,
        );
    levels.set(node.skillId, node.level);
  }
  return levels;
}

export function trainingText(nodes: Requirement[], catalog: SkillCatalog) {
  return nodes
    .map(
      (node) =>
        `${catalog.skill(node.skillId).name} ${ROMAN_LEVELS[node.level]}`,
    )
    .join("\n");
}

export function skillPoints(rank: number, level: number): number {
  return level === 0 ? 0 : Math.ceil(250 * rank * 2 ** (2.5 * (level - 1)));
}
