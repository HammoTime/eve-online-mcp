import type { OperationCatalog } from "./openapi.js";
import type { OperationDescriptor } from "./types.js";

// Stable precedence: exact ID > exact path > curated intent > lexical evidence.
const SCORE = {
  exactOperationId: 10_000,
  exactPath: 9_000,
  intentPhrase: 8_000,
  operationIdToken: 80,
  pathToken: 60,
  summaryToken: 40,
  descriptionToken: 20,
  tagToken: 15,
  scopeToken: 10,
} as const;

const FILLER_WORDS = new Set([
  "a",
  "am",
  "an",
  "are",
  "can",
  "do",
  "does",
  "for",
  "get",
  "how",
  "i",
  "in",
  "is",
  "me",
  "my",
  "of",
  "please",
  "show",
  "the",
  "to",
  "what",
  "where",
  "with",
]);

const INTENT_ALIASES: readonly {
  phrases: readonly string[];
  operationId: string;
}[] = [
  {
    phrases: ["where am i"],
    operationId: "GetCharactersCharacterIdLocation",
  },
  {
    phrases: ["current ship", "what am i flying"],
    operationId: "GetCharactersCharacterIdShip",
  },
  {
    phrases: ["training queue"],
    operationId: "GetCharactersCharacterIdSkillqueue",
  },
  {
    phrases: ["trained skills"],
    operationId: "GetCharactersCharacterIdSkills",
  },
  {
    phrases: ["wallet balance", "how much isk"],
    operationId: "GetCharactersCharacterIdWallet",
  },
  {
    phrases: ["what do i own", "my assets"],
    operationId: "GetCharactersCharacterIdAssets",
  },
];

export interface DetailedOperationMatch {
  operation: OperationDescriptor;
  matchReasons: string[];
}

export interface DetailedSearchResult {
  matches: DetailedOperationMatch[];
  totalMatches: number;
  offset: number;
  hasMore: boolean;
  nextOffset: number | null;
}

function normalize(value: string): string {
  return value
    .replace(/([a-z\d])([A-Z])/gu, "$1 $2")
    .toLowerCase()
    .replace(/[^a-z\d]+/gu, " ")
    .trim();
}

function tokens(value: string): Set<string> {
  return new Set(normalize(value).split(/\s+/u).filter(Boolean));
}

function lexicalScore(
  operation: OperationDescriptor,
  queryTokens: readonly string[],
): { score: number; reasons: string[] } | undefined {
  const fields = [
    ["operation ID", operation.operationId, SCORE.operationIdToken],
    ["path", operation.path, SCORE.pathToken],
    ["summary", operation.summary, SCORE.summaryToken],
    ["description", operation.description, SCORE.descriptionToken],
    ["tag", operation.tags.join(" "), SCORE.tagToken],
    ["scope", operation.requiredScopes.join(" "), SCORE.scopeToken],
  ] as const;
  let score = 0;
  const reasons: string[] = [];
  for (const token of queryTokens) {
    let matched = false;
    for (const [label, value, weight] of fields) {
      if (tokens(value).has(token) || normalize(value).includes(token)) {
        score += weight;
        matched = true;
        if (!reasons.includes(`lexical match in ${label}`))
          reasons.push(`lexical match in ${label}`);
      }
    }
    if (!matched) return undefined;
  }
  return score > 0 ? { score, reasons } : undefined;
}

export function searchOperationsDetailed(
  catalog: OperationCatalog,
  options: {
    query?: string;
    tag?: string;
    authenticated?: boolean;
    limit?: number;
    offset?: number;
  },
): DetailedSearchResult {
  const rawQuery = options.query?.trim() ?? "";
  const normalizedQuery = normalize(rawQuery);
  const tag = options.tag?.trim().toLowerCase();
  const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);
  const offset = Math.max(options.offset ?? 0, 0);
  const eligible = catalog.operations.filter((operation) => {
    if (
      options.authenticated !== undefined &&
      operation.requiredScopes.length > 0 !== options.authenticated
    )
      return false;
    return !tag || operation.tags.some((value) => value.toLowerCase() === tag);
  });

  const ranked = rawQuery
    ? eligible
        .map((operation) => {
          let score = 0;
          const matchReasons: string[] = [];
          if (operation.operationId.toLowerCase() === rawQuery.toLowerCase()) {
            score += SCORE.exactOperationId;
            matchReasons.push("exact operation ID");
          }
          if (operation.path.toLowerCase() === rawQuery.toLowerCase()) {
            score += SCORE.exactPath;
            matchReasons.push("exact path");
          }
          for (const alias of INTENT_ALIASES) {
            const phrase = alias.phrases.find((value) =>
              normalizedQuery.includes(value),
            );
            if (phrase && alias.operationId === operation.operationId) {
              score += SCORE.intentPhrase;
              matchReasons.push(`recognized phrase: ${phrase}`);
            }
          }
          const meaningfulTokens = normalizedQuery
            .split(/\s+/u)
            .filter((value) => value && !FILLER_WORDS.has(value));
          const lexical =
            meaningfulTokens.length > 0
              ? lexicalScore(operation, meaningfulTokens)
              : undefined;
          if (lexical) {
            score += lexical.score;
            matchReasons.push(...lexical.reasons);
          }
          return { operation, matchReasons, score };
        })
        .filter((match) => match.score > 0)
        .sort(
          (left, right) =>
            right.score - left.score ||
            left.operation.operationId.localeCompare(
              right.operation.operationId,
            ),
        )
    : eligible.map((operation) => ({
        operation,
        matchReasons: [] as string[],
        score: 0,
      }));

  const totalMatches = ranked.length;
  const matches = ranked.slice(offset, offset + limit).map((match) => ({
    operation: match.operation,
    matchReasons: match.matchReasons,
  }));
  const nextOffset = offset + matches.length;
  return {
    matches,
    totalMatches,
    offset,
    hasMore: nextOffset < totalMatches,
    nextOffset: nextOffset < totalMatches ? nextOffset : null,
  };
}
