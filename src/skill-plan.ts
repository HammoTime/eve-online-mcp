import * as z from "zod/v4";
import type { EsiClient, EsiResponse } from "./esi-client.js";
import {
  buildSkillGraph,
  replayTraining,
  skillPoints,
  trainingText,
} from "./skill-graph.js";
import {
  SkillCatalog,
  type PlanTarget,
  type Requirement,
  skillLevel,
  typeId,
} from "./skill-data.js";
import type { StaticDataSource } from "./static-data.js";
import { sourceMetadata } from "./workflow-common.js";

const observedLevel = z.number().int().min(0).max(5);
const skillsSchema = z.object({
  skills: z
    .array(
      z.object({
        skill_id: typeId,
        trained_skill_level: observedLevel,
        active_skill_level: observedLevel,
        skillpoints_in_skill: z.number().int().nonnegative(),
      }),
    )
    .max(10_000),
  total_sp: z.number().int().nonnegative(),
});
const queueSchema = z
  .array(
    z.object({
      skill_id: typeId,
      finished_level: skillLevel,
      queue_position: z.number().int().nonnegative(),
      level_end_sp: z.number().int().nonnegative().optional(),
      start_date: z.iso.datetime().optional(),
      finish_date: z.iso.datetime().optional(),
    }),
  )
  .max(150);
export interface SkillPlanInput {
  characterId: number;
  targets: PlanTarget[];
  queuePolicy?: "preserve" | "reorder";
}

function complete(response: EsiResponse) {
  if (
    response.status !== 200 ||
    response.pagination.hasMore === true ||
    (response.pagination.totalPages ?? 1) > 1
  )
    throw new Error(
      "A complete successful character response is required; missing progress cannot be treated as zero",
    );
  return response.data;
}

export class SkillPlanner {
  constructor(
    private readonly source: StaticDataSource,
    private readonly client: EsiClient,
  ) {}
  async dependencies(targets: PlanTarget[]) {
    const { catalog, status } = await this.source.initialize();
    const resolvedTargets = targets.map((target) => catalog.resolve(target));
    if (resolvedTargets.some((target) => target.status !== "resolved"))
      return {
        status: "needs_target_selection",
        resolvedTargets,
        staticData: status,
      };
    const requirements = resolvedTargets.flatMap((target) =>
      target.status === "resolved" ? target.requirements : [],
    );
    return {
      status: "complete",
      resolvedTargets,
      staticData: status,
      graph: buildSkillGraph(catalog, requirements),
      scope:
        "Permanent training prerequisites and minimum hull requirements; fitting and clone eligibility are separate.",
    };
  }
  async generate(input: SkillPlanInput) {
    const { catalog, status } = await this.source.initialize();
    const resolvedTargets = input.targets.map((target) =>
      catalog.resolve(target),
    );
    // Resolve public targets before triggering character authorization.
    if (resolvedTargets.some((target) => target.status !== "resolved"))
      return {
        status: "needs_target_selection",
        resolvedTargets,
        staticData: status,
      };
    const requirements = resolvedTargets.flatMap((target) =>
      target.status === "resolved" ? target.requirements : [],
    );
    const authorization = await this.client.authorize(
      ["esi-skills.read_skills.v1", "esi-skills.read_skillqueue.v1"],
      input.characterId,
    );
    const skillsResponse = await this.client.call(
      {
        operationId: "GetCharactersCharacterIdSkills",
        path: { character_id: input.characterId },
      },
      authorization,
    );
    const queueResponse = await this.client.call(
      {
        operationId: "GetCharactersCharacterIdSkillqueue",
        path: { character_id: input.characterId },
      },
      authorization,
    );
    const skills = skillsSchema.parse(complete(skillsResponse));
    const queue = queueSchema
      .parse(complete(queueResponse))
      .sort((a, b) => a.queue_position - b.queue_position);
    if (
      new Set(skills.skills.map((skill) => skill.skill_id)).size !==
        skills.skills.length ||
      new Set(queue.map((row) => row.queue_position)).size !== queue.length
    )
      throw new Error("Duplicate skill or queue-position evidence");
    const trained = new Map(
      skills.skills.map((skill) => [skill.skill_id, skill.trained_skill_level]),
    );
    const active = new Map(
      skills.skills.map((skill) => [skill.skill_id, skill.active_skill_level]),
    );
    const points = new Map(
      skills.skills.map((skill) => [
        skill.skill_id,
        skill.skillpoints_in_skill,
      ]),
    );
    const policy = input.queuePolicy ?? "preserve";
    const commitments: Requirement[] = [];
    const commitmentPoints = new Map<number, number>();
    const completedAt = Date.parse(queueResponse.freshness.fetchedAt);
    const queueKeys = new Set<string>();
    for (const row of queue) {
      const key = `${row.skill_id}:${row.finished_level}`;
      if (queueKeys.has(key))
        throw new Error("Duplicate skill-level entries in observed queue");
      queueKeys.add(key);
      if ((trained.get(row.skill_id) ?? 0) >= row.finished_level) continue;
      if (row.finish_date && Date.parse(row.finish_date) <= completedAt)
        throw new Error(
          "Completed queue entries conflict with the skills snapshot. Refresh character skills before producing an importable plan.",
        );
      if (
        row.start_date &&
        row.finish_date &&
        Date.parse(row.start_date) >= Date.parse(row.finish_date)
      )
        throw new Error("Invalid queue timestamps");
      const skill = catalog.skill(row.skill_id);
      const estimated = skillPoints(skill.rank, row.finished_level);
      if (
        row.level_end_sp !== undefined &&
        Math.abs(row.level_end_sp - estimated) > 1
      )
        throw new Error("Queue SP threshold conflicts with the SDE skill rank");
      commitments.push({ skillId: row.skill_id, level: row.finished_level });
      commitmentPoints.set(
        row.skill_id,
        Math.max(
          commitmentPoints.get(row.skill_id) ?? 0,
          row.level_end_sp ?? estimated,
        ),
      );
    }
    const baseline =
      policy === "preserve"
        ? replayTraining(catalog, commitments, trained)
        : new Map(trained);
    const baselinePoints = new Map(points);
    if (policy === "preserve")
      for (const [id, sp] of commitmentPoints)
        baselinePoints.set(id, Math.max(baselinePoints.get(id) ?? 0, sp));
    const allTargets =
      policy === "reorder" ? [...requirements, ...commitments] : requirements;
    const graph = buildSkillGraph(catalog, allTargets, baseline);
    const finalLevels = replayTraining(catalog, graph.nodes, baseline);
    if (
      allTargets.some((req) => (finalLevels.get(req.skillId) ?? 0) < req.level)
    )
      throw new Error("Skill plan does not satisfy every target");
    const rows = planRows(
      catalog,
      graph.nodes,
      baseline,
      baselinePoints,
      trained,
      active,
    );
    const additionalSkillPointsEstimate = rows.reduce(
      (sum, row) => sum + row.remainingSkillPointsEstimate,
      0,
    );
    const acquisitionChecks = [
      ...new Set(
        graph.nodes
          .filter((node) => !trained.has(node.skillId))
          .map((node) => node.skillId),
      ),
    ].map((id) => ({
      skillId: id,
      name: catalog.skill(id).name,
      action:
        "Check skillbook ownership or direct character-sheet purchase before injection.",
    }));
    return {
      status: "complete",
      dependencyChecked: true,
      characterId: input.characterId,
      queuePolicy: policy,
      resolvedTargets,
      staticData: status,
      baseline:
        policy === "preserve"
          ? "conditional after retained queue"
          : "observed trained skills",
      characterSources: {
        skills: sourceMetadata(skillsResponse),
        skillQueue: sourceMetadata(queueResponse),
      },
      atomic: false,
      retainedQueue: queue,
      plan: rows,
      graph,
      additionalSkillPointsEstimate,
      trainingText: trainingText(graph.nodes, catalog),
      trainingTextKind:
        policy === "preserve"
          ? "additions after retained queue"
          : "proposed replacement including existing commitments",
      acquisitionChecks,
      queueSlotsRemaining: Math.max(0, 150 - commitments.length),
      caveats: [
        "No game state was changed. Review the plan and import preview in game.",
        "Only permanent trained levels are removed as completed; future queued levels are conditional commitments, not current progress.",
        "Dependency order is validated; clone eligibility, Alpha caps/ceiling, fit validity, time, budget and optimal milestone timing are not calculated.",
        "SP totals are estimates using ceil(250 * rank * 2^(2.5*(level-1))); published rounding conventions may differ by one SP. Active training can advance after these separate snapshots.",
        "A ship target covers its minimum hull requirements, not its fit or practical support skills. A bare skill target means level I.",
        ...(policy === "preserve"
          ? [
              "Additions assume the entire retained queue completes unchanged; paused queues require resuming.",
            ]
          : [
              "Reordering retains unrelated queued targets, may invalidate existing finish dates, and does not promise the fastest useful milestone.",
            ]),
      ],
    };
  }
}

function planRows(
  catalog: SkillCatalog,
  nodes: Requirement[],
  baseline: ReadonlyMap<number, number>,
  points: ReadonlyMap<number, number>,
  trained: ReadonlyMap<number, number>,
  active: ReadonlyMap<number, number>,
) {
  const charged = new Set<number>();
  return nodes.map((node) => {
    const skill = catalog.skill(node.skillId);
    const current = baseline.get(node.skillId) ?? 0;
    const observedSP = points.get(node.skillId) ?? 0;
    if (
      observedSP < skillPoints(skill.rank, current) - 1 ||
      (current < 5 && observedSP > skillPoints(skill.rank, current + 1))
    )
      throw new Error(
        `Inconsistent level/SP baseline for ${skill.id}; refresh skills`,
      );
    const before = charged.has(skill.id)
      ? skillPoints(skill.rank, node.level - 1)
      : observedSP;
    charged.add(skill.id);
    return {
      ...node,
      name: skill.name,
      observedTrainedLevel: trained.get(skill.id) ?? 0,
      observedActiveLevel: active.get(skill.id) ?? 0,
      baselineLevel: current,
      remainingSkillPointsEstimate: Math.max(
        0,
        skillPoints(skill.rank, node.level) - before,
      ),
    };
  });
}
