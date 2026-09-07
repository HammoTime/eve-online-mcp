import { describe, it, expect, vi } from "vitest";
import { StaticTokenProvider } from "../src/auth.js";
import { EsiClient, type EsiResponse } from "../src/esi-client.js";
import { OperationCatalog } from "../src/openapi.js";
import { SkillPlanner } from "../src/skill-plan.js";
import { fixtureDocument } from "./fixtures.js";
import { fixtureSource } from "./skill-fixtures.js";
import type { JsonValue } from "../src/types.js";

export function observedSkill(id = 100, level = 1, sp = 250, active = level) {
  return {
    skill_id: id,
    trained_skill_level: level,
    active_skill_level: active,
    skillpoints_in_skill: sp,
  };
}
export function queueRow(id = 100, level = 2, position = 0) {
  return { skill_id: id, finished_level: level, queue_position: position };
}
export function plannerClient(
  skills: JsonValue = { skills: [observedSkill()], total_sp: 250 },
  queue: JsonValue = [],
) {
  const client = new EsiClient(
    new OperationCatalog(fixtureDocument()),
    new StaticTokenProvider(undefined),
  );
  const authorize = vi
    .spyOn(client, "authorize")
    .mockResolvedValue({ authorizationContext: "esi" });
  const responses = [skills, queue].map((data, index): EsiResponse => ({
    operationId:
      index === 0
        ? "GetCharactersCharacterIdSkills"
        : "GetCharactersCharacterIdSkillqueue",
    status: 200,
    url: `https://esi.evetech.net/characters/42/${index === 0 ? "skills" : "skillqueue"}`,
    cached: false,
    headers: {},
    data,
    freshness: {
      fetchedAt: "2026-09-07T00:00:00Z",
      servedAt: "2026-09-07T00:00:00Z",
      expiresAt: null,
      sourceLastModified: null,
    },
    pagination: {
      mode: "none",
      currentPage: null,
      totalPages: null,
      hasMore: false,
      nextCall: null,
    },
  }));
  const call = vi.spyOn(client, "call").mockImplementation((input) => {
    const result = responses.find(
      (response) => response.operationId === input.operationId,
    );
    if (!result) throw new Error("Unexpected ESI operation");
    return Promise.resolve(result);
  });
  return {
    client,
    authorize,
    call,
    responses,
    planner: new SkillPlanner(fixtureSource(), client),
  };
}
function requiredResponse(responses: EsiResponse[], index: number) {
  const response = responses[index];
  if (!response) throw new Error("Missing test response");
  return response;
}

describe("personalized deterministic skill planning", () => {
  it("subtracts permanently trained levels and partial SP once, preserving active-level evidence", async () => {
    const { planner, authorize, call } = plannerClient({
      skills: [observedSkill(100, 1, 1000, 0)],
      total_sp: 1000,
    });
    const result = await planner.generate({
      characterId: 42,
      targets: ["Mining III"],
    });
    expect(result).toMatchObject({
      status: "complete",
      dependencyChecked: true,
      trainingText: "Mining II\nMining III",
      additionalSkillPointsEstimate: 7000,
      plan: [
        {
          observedTrainedLevel: 1,
          observedActiveLevel: 0,
          remainingSkillPointsEstimate: 415,
        },
        { remainingSkillPointsEstimate: 6585 },
      ],
    });
    expect(authorize).toHaveBeenCalledWith(
      ["esi-skills.read_skills.v1", "esi-skills.read_skillqueue.v1"],
      42,
    );
    expect(call).toHaveBeenCalledTimes(2);
    for (const [input, authorization] of call.mock.calls) {
      expect(input.path).toEqual({ character_id: 42 });
      expect(authorization).toEqual({ authorizationContext: "esi" });
    }
  });
  it("keeps future queue progress conditional and emits only additions under preserve", async () => {
    const { planner } = plannerClient(undefined, [
      {
        ...queueRow(),
        level_end_sp: 1415,
        start_date: "2026-09-07T00:00:00Z",
        finish_date: "2026-09-08T00:00:00Z",
      },
      queueRow(300, 1, 1),
    ]);
    const result = await planner.generate({
      characterId: 42,
      targets: ["Exhumer"],
    });
    expect(result).toMatchObject({
      status: "complete",
      baseline: "conditional after retained queue",
      trainingText: "Exhumers I",
      additionalSkillPointsEstimate: 250,
      queueSlotsRemaining: 148,
      acquisitionChecks: [{ skillId: 200 }],
    });
    expect(result.retainedQueue).toHaveLength(2);
  });
  it("retains unrelated queue commitments when proposing reorder, and deduplicates overlap", async () => {
    const { planner } = plannerClient(undefined, [
      queueRow(300, 1, 1),
      queueRow(100, 2, 0),
    ]);
    const result = await planner.generate({
      characterId: 42,
      targets: ["Exhumers", "Mining II"],
      queuePolicy: "reorder",
    });
    expect(result).toMatchObject({
      status: "complete",
      baseline: "observed trained skills",
      additionalSkillPointsEstimate: 1665,
    });
    expect(result.plan?.map((row) => row.skillId)).toEqual([100, 200, 300]);
    expect(result.trainingTextKind).toContain("replacement");
  });
  it("returns an empty plan for completed goals and ignores already completed queue rows", async () => {
    const { planner } = plannerClient(undefined, [queueRow(100, 1)]);
    expect(
      await planner.generate({ characterId: 42, targets: ["Mining I"] }),
    ).toMatchObject({
      status: "complete",
      plan: [],
      trainingText: "",
      additionalSkillPointsEstimate: 0,
    });
  });
  it("does not require authentication to resolve targets or inspect public dependencies", async () => {
    const { planner, authorize, call } = plannerClient();
    expect(
      await planner.generate({ characterId: 42, targets: ["unknown"] }),
    ).toMatchObject({ status: "needs_target_selection" });
    expect(await planner.dependencies(["unknown"])).toMatchObject({
      status: "needs_target_selection",
    });
    expect(await planner.dependencies(["Test Hull"])).toMatchObject({
      status: "complete",
      graph: { nodes: expect.any(Array) },
    });
    expect(authorize).not.toHaveBeenCalled();
    expect(call).not.toHaveBeenCalled();
  });
  it("stops on auth failure or incomplete private evidence instead of assuming zero progress", async () => {
    const { planner, authorize, call } = plannerClient();
    authorize.mockRejectedValue(new Error("Consent required"));
    await expect(
      planner.generate({ characterId: 42, targets: ["Mining II"] }),
    ).rejects.toThrow("Consent");
    expect(call).not.toHaveBeenCalled();
    for (const change of [
      { status: 503 },
      {
        pagination: {
          mode: "none" as const,
          currentPage: null,
          totalPages: 2,
          hasMore: false,
          nextCall: null,
        },
      },
      {
        pagination: {
          mode: "page" as const,
          currentPage: 1,
          totalPages: null,
          hasMore: true,
          nextCall: null,
        },
      },
      { data: { skills: [] } },
    ]) {
      const fixture = plannerClient();
      Object.assign(requiredResponse(fixture.responses, 0), change);
      await expect(
        fixture.planner.generate({ characterId: 42, targets: ["Mining II"] }),
      ).rejects.toThrow();
    }
  });
  it.each([
    [[queueRow(), queueRow(300, 1)], "Duplicate skill or queue-position"],
    [[queueRow(), queueRow(100, 2, 1)], "Duplicate skill-level"],
    [[{ ...queueRow(), finish_date: "2026-09-06T00:00:00Z" }], "conflict"],
    [
      [
        {
          ...queueRow(),
          start_date: "2026-09-09T00:00:00Z",
          finish_date: "2026-09-08T00:00:00Z",
        },
      ],
      "timestamps",
    ],
    [[{ ...queueRow(), level_end_sp: 9999 }], "SP threshold"],
    [[queueRow(300, 1)], "Missing prerequisite"],
  ])("rejects inconsistent queue evidence: %j", async (queue, message) => {
    const { planner } = plannerClient(undefined, queue);
    await expect(
      planner.generate({ characterId: 42, targets: ["Mining III"] }),
    ).rejects.toThrow(message);
  });
  it("rejects duplicate skills and impossible SP baselines", async () => {
    for (const skills of [
      [observedSkill(), observedSkill()],
      [observedSkill(100, 1, 0)],
      [observedSkill(100, 1, 8000)],
    ]) {
      const { planner } = plannerClient({ skills, total_sp: 8000 });
      await expect(
        planner.generate({ characterId: 42, targets: ["Mining III"] }),
      ).rejects.toThrow();
    }
  });
  it("replays every level of a multi-level queue and charges only post-queue increments", async () => {
    const { planner } = plannerClient({ skills: [], total_sp: 0 }, [
      queueRow(100, 1),
      queueRow(100, 2, 1),
    ]);
    expect(
      await planner.generate({ characterId: 42, targets: ["Mining III"] }),
    ).toMatchObject({
      trainingText: "Mining III",
      additionalSkillPointsEstimate: 6585,
    });
  });
  it("returns stale SDE provenance and does not persist private snapshots", async () => {
    const { client } = plannerClient();
    const source = fixtureSource();
    const initialized = await source.initialize();
    const initialize = vi.spyOn(source, "initialize").mockResolvedValue({
      ...initialized,
      status: { stale: true, buildNumber: 123, warning: "Offline" },
    });
    const planner = new SkillPlanner(source, client);
    expect(
      await planner.generate({ characterId: 42, targets: ["Mining II"] }),
    ).toMatchObject({
      staticData: { stale: true, buildNumber: 123 },
      atomic: false,
    });
    expect(initialize).toHaveBeenCalledTimes(1);
  });
});
