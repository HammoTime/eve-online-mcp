import {
  EsiRequestError,
  publicEsiError,
  type EsiAuthorization,
  type EsiClient,
} from "./esi-client.js";
import type { OperationCatalog } from "./openapi.js";
import { sourceMetadata } from "./workflow-common.js";

export const CHARACTER_SECTIONS = {
  profile: "GetCharactersCharacterId",
  location: "GetCharactersCharacterIdLocation",
  ship: "GetCharactersCharacterIdShip",
  skills: "GetCharactersCharacterIdSkills",
  skillQueue: "GetCharactersCharacterIdSkillqueue",
  wallet: "GetCharactersCharacterIdWallet",
} as const;

export type CharacterSection = keyof typeof CHARACTER_SECTIONS;

const SKILLS_CAVEAT =
  "Completed skill-queue entries can precede updates to the skills endpoint until the character next logs in; this tool does not infer adjusted skill levels.";

function responseLimitError(limit: number): EsiRequestError {
  return new EsiRequestError(
    `Character context section exceeds the ${limit} byte aggregate result limit`,
    undefined,
    undefined,
    { code: "RESPONSE_LIMIT", retryable: false },
  );
}

function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}

export async function getCharacterContext(
  client: EsiClient,
  catalog: OperationCatalog,
  input: { characterId: number; sections: CharacterSection[] },
  options: { maxResultBytes?: number } = {},
): Promise<Record<string, unknown>> {
  const maxResultBytes = options.maxResultBytes ?? 5_000_000;
  const caveats = input.sections.some(
    (section) => section === "skills" || section === "skillQueue",
  )
    ? [
        SKILLS_CAVEAT,
        "Each section is fetched separately; successful retrieval does not guarantee identical observation time or freshness.",
      ]
    : [
        "Each section is fetched separately; successful retrieval does not guarantee identical observation time or freshness.",
      ];
  const selected = input.sections.map((section) => ({
    section,
    operation: catalog.get(CHARACTER_SECTIONS[section]),
  }));
  const requiredScopes = [
    ...new Set(selected.flatMap(({ operation }) => operation.requiredScopes)),
  ].sort();
  let authorization: EsiAuthorization | undefined;
  let authorizationError: unknown;
  if (requiredScopes.length > 0) {
    try {
      authorization = await client.authorize(requiredScopes);
    } catch (error) {
      authorizationError = error;
    }
  }

  const sections: Record<string, unknown> = {};
  let successes = 0;
  for (const { section, operation } of selected) {
    if (operation.requiredScopes.length > 0 && authorizationError) {
      sections[section] = {
        status: "error",
        error: publicEsiError(authorizationError),
      };
      continue;
    }
    try {
      const response = await client.call(
        {
          operationId: operation.operationId,
          path: { character_id: input.characterId },
        },
        operation.requiredScopes.length > 0 ? authorization : undefined,
      );
      const sectionResult = {
        status: "ok",
        data: response.data,
        source: sourceMetadata(response),
      };
      const candidate = {
        characterId: input.characterId,
        requestedSections: input.sections,
        status: "complete",
        sections: { ...sections, [section]: sectionResult },
        atomic: false,
        caveats,
      };
      if (serializedBytes(candidate) > maxResultBytes) {
        sections[section] = {
          status: "error",
          error: publicEsiError(responseLimitError(maxResultBytes)),
        };
      } else {
        sections[section] = sectionResult;
        successes += 1;
      }
    } catch (error) {
      sections[section] = { status: "error", error: publicEsiError(error) };
    }
  }

  const buildResult = () => ({
    characterId: input.characterId,
    requestedSections: input.sections,
    status:
      successes === selected.length
        ? "complete"
        : successes === 0
          ? "failed"
          : "partial",
    sections,
    atomic: false,
    caveats,
  });
  let result = buildResult();
  for (const section of [...input.sections].reverse()) {
    if (serializedBytes(result) <= maxResultBytes) break;
    const sectionResult = sections[section];
    if (
      typeof sectionResult === "object" &&
      sectionResult !== null &&
      "status" in sectionResult &&
      sectionResult.status === "ok"
    ) {
      sections[section] = {
        status: "error",
        error: publicEsiError(responseLimitError(maxResultBytes)),
      };
      successes -= 1;
      result = buildResult();
    }
  }
  return result;
}
