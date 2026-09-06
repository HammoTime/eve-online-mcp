import { EsiRequestError, type EsiClient } from "./esi-client.js";
import type { JsonValue } from "./types.js";
import { sourceMetadata } from "./workflow-common.js";

export type EntityResolutionInput = { names: string[] } | { ids: number[] };

interface Candidate {
  id: number;
  name: string;
  category: string;
}

const CATEGORY_MAP: Readonly<Record<string, string>> = {
  agents: "agent",
  agent: "agent",
  alliances: "alliance",
  alliance: "alliance",
  characters: "character",
  character: "character",
  constellations: "constellation",
  constellation: "constellation",
  corporations: "corporation",
  corporation: "corporation",
  factions: "faction",
  faction: "faction",
  inventory_types: "inventory_type",
  inventory_type: "inventory_type",
  regions: "region",
  region: "region",
  stations: "station",
  station: "station",
  systems: "solar_system",
  solar_system: "solar_system",
};

function invalidResponse(message: string): EsiRequestError {
  return new EsiRequestError(message, undefined, undefined, {
    code: "INVALID_UPSTREAM_RESPONSE",
    retryable: false,
  });
}

function isRecord(
  value: JsonValue | string | null,
): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function candidateFrom(value: JsonValue, upstreamCategory: string): Candidate {
  if (
    !isRecord(value) ||
    typeof value.id !== "number" ||
    !Number.isSafeInteger(value.id) ||
    value.id <= 0 ||
    typeof value.name !== "string"
  )
    throw invalidResponse(
      "ESI entity resolution returned a malformed candidate",
    );
  return {
    id: value.id,
    name: value.name,
    category: CATEGORY_MAP[upstreamCategory] ?? upstreamCategory,
  };
}

function statusFor(
  candidates: Candidate[],
): "resolved" | "ambiguous" | "unresolved" {
  if (candidates.length === 0) return "unresolved";
  return candidates.length === 1 ? "resolved" : "ambiguous";
}

function uniqueNames(names: string[]): string[] {
  const seen = new Set<string>();
  return names.filter((name) => {
    const key = name.toLocaleLowerCase("en-US");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function resolveEveEntities(
  client: EsiClient,
  input: EntityResolutionInput,
): Promise<Record<string, unknown>> {
  if ("names" in input) {
    const response = await client.call({
      operationId: "PostUniverseIds",
      body: uniqueNames(input.names),
    });
    if (!isRecord(response.data))
      throw invalidResponse("ESI name resolution did not return an object");
    const candidates: Candidate[] = [];
    for (const [category, values] of Object.entries(response.data)) {
      if (!Array.isArray(values))
        throw invalidResponse(
          `ESI name resolution category ${category} was not an array`,
        );
      candidates.push(...values.map((value) => candidateFrom(value, category)));
    }
    return {
      matchMode: "exact",
      results: input.names.map((name) => {
        const matches = candidates.filter(
          (candidate) =>
            candidate.name.toLocaleLowerCase("en-US") ===
            name.toLocaleLowerCase("en-US"),
        );
        return {
          input: name,
          status: statusFor(matches),
          candidates: matches,
        };
      }),
      source: sourceMetadata(response),
    };
  }

  const response = await client.call({
    operationId: "PostUniverseNames",
    body: [...new Set(input.ids)],
  });
  if (!Array.isArray(response.data))
    throw invalidResponse("ESI ID resolution did not return an array");
  const candidates = response.data.map((value) => {
    if (!isRecord(value) || typeof value.category !== "string")
      throw invalidResponse("ESI ID resolution returned a malformed candidate");
    return candidateFrom(value, value.category);
  });
  return {
    matchMode: "exact",
    results: input.ids.map((id) => {
      const matches = candidates.filter((candidate) => candidate.id === id);
      return {
        input: id,
        status: statusFor(matches),
        candidates: matches,
      };
    }),
    source: sourceMetadata(response),
    caveat:
      "Depending on upstream behavior, one invalid ID can cause ESI to reject the entire batch.",
  };
}
