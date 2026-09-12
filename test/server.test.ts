import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  InteractiveSsoTokenProvider,
  StaticTokenProvider,
} from "../src/auth.js";
import { CharacterAuthentication } from "../src/character-authentication.js";
import { CredentialStore } from "../src/credential-store.js";
import { EsiClient } from "../src/esi-client.js";
import { OperationCatalog } from "../src/openapi.js";
import { createEveServer } from "../src/server.js";
import { fixtureDocument } from "./fixtures.js";
import { fixtureSource, skillFixture } from "./skill-fixtures.js";
import { StaticDataCache, type StaticDataSource } from "../src/static-data.js";
import type { readStaticArchive } from "../src/static-data-archive.js";
import { SkillImport } from "../src/skill-store.js";
import type { OpenApiDocument } from "../src/types.js";
import type { SsoLoginOptions } from "../src/sso.js";
import {
  testCredential,
  testVerifier,
  trainingScopes,
} from "./auth-fixtures.js";

const connections: { close(): Promise<void> }[] = [];
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(connections.splice(0).map(async (value) => value.close()));
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function connectedClient(
  esiOverride?: EsiClient,
  staticData: StaticDataSource = fixtureSource(),
  authentication?: CharacterAuthentication,
) {
  const catalog = new OperationCatalog(fixtureDocument());
  const esiClient = new EsiClient(catalog, new StaticTokenProvider(undefined), {
    baseUrl: "http://localhost",
    fetchImplementation: vi
      .fn<typeof fetch>()
      .mockImplementation((url, init) => {
        const href =
          url instanceof URL
            ? url.href
            : typeof url === "string"
              ? url
              : url.url;
        if (init?.method === "POST" && href.includes("/universe/ids"))
          return Promise.resolve(
            new Response(
              JSON.stringify({
                inventory_types: [{ id: 34, name: "Tritanium" }],
              }),
            ),
          );
        if (href.includes("/characters/"))
          return Promise.resolve(new Response('{"name":"Pilot"}'));
        if (href.includes("/markets/"))
          return Promise.resolve(
            new Response("[]", { headers: { "x-pages": "1" } }),
          );
        return Promise.resolve(
          new Response(JSON.stringify({ players: 123 }), { status: 200 }),
        );
      }),
  });
  const server = createEveServer(
    catalog,
    esiOverride ?? esiClient,
    authentication,
    staticData,
  );
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  connections.push(client, server);
  return client;
}

describe("EVE MCP server", () => {
  it("reports the installed package version during MCP initialization", async () => {
    const metadata = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version: string };
    const client = await connectedClient();

    expect(client.getServerVersion()).toEqual({
      name: "eve-online-mcp",
      version: metadata.version,
    });
  });

  it("advertises EVE discovery guidance during initialization without ESI access", async () => {
    const fetchImplementation = vi.fn<typeof fetch>();
    const getAccessToken = vi.fn<StaticTokenProvider["getAccessToken"]>();
    const catalog = new OperationCatalog(fixtureDocument());
    const client = await connectedClient(
      new EsiClient(catalog, { getAccessToken }, { fetchImplementation }),
    );

    const instructions = client.getInstructions() ?? "";
    const discoverySummary = instructions.slice(0, 512);
    expect(discoverySummary).toContain("EVE Online");
    expect(discoverySummary).toMatch(/read-only/i);
    expect(discoverySummary).toContain("character sheets");
    expect(discoverySummary).toContain("skill queues");
    expect(discoverySummary).toContain("game client");
    for (const name of [
      "resolve_eve_entities",
      "get_character_context",
      "search_esi_operations",
    ]) {
      expect(discoverySummary).toContain(name);
    }
    expect(instructions).toContain("explicit character ID");
    expect(instructions).toContain("Public operations need no login");
    expect(instructions).toContain("EVE SSO");
    expect(instructions).toContain("does not expose Omega subscription status");
    expect(instructions).toContain("saved in-game skill plans");

    const { tools } = await client.listTools();
    for (const tool of tools) {
      expect(tool.title).toContain("EVE Online");
      expect(tool.description).toContain("EVE Online");
      expect(tool.annotations).toMatchObject({
        readOnlyHint: ![
          "authorize_eve_character",
          "select_eve_character",
          "render_eve_map",
        ].includes(tool.name),
        destructiveHint: false,
        idempotentHint: !["authorize_eve_character", "render_eve_map"].includes(
          tool.name,
        ),
      });
    }
    expect(fetchImplementation).not.toHaveBeenCalled();
    expect(getAccessToken).not.toHaveBeenCalled();
  });

  it("describes character planning entry points in the tool listing", async () => {
    const client = await connectedClient();
    const { tools } = await client.listTools();
    const resolve = tools.find((tool) => tool.name === "resolve_eve_entities");
    expect(resolve?.description).toContain("character names");
    expect(resolve?.description).toContain("get_character_context");
    const character = tools.find(
      (tool) => tool.name === "get_character_context",
    );
    for (const keyword of [
      "character sheet",
      "skills",
      "skill queue",
      "hauling",
      "skill plans",
      "skill injector",
      "EVE SSO",
    ]) {
      expect(character?.description).toContain(keyword);
    }
    expect(character?.inputSchema.properties).toMatchObject({
      characterId: {
        description: expect.stringContaining("resolve_eve_entities"),
      },
      sections: { description: expect.stringContaining("skillQueue") },
    });
    const search = tools.find((tool) => tool.name === "search_esi_operations");
    expect(search?.description).toContain("assets");
    expect(search?.description).toContain("routes");
    expect(search?.description).toContain("get_esi_operation");
  });

  it("exposes the discovery and call tools over MCP", async () => {
    const client = await connectedClient();
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual([
      "initialize_static_data",
      "resolve_skill_plan_targets",
      "get_skill_dependencies",
      "generate_skill_plan",
      "list_eve_characters",
      "authorize_eve_character",
      "select_eve_character",
      "search_esi_operations",
      "get_esi_operation",
      "call_esi",
      "resolve_eve_entities",
      "get_character_context",
      "get_market_snapshot",
      "render_eve_map",
    ]);
    expect(tools.filter((tool) => tool.name !== "render_eve_map")).toHaveLength(
      13,
    );
    expect(tools).toHaveLength(14);
    for (const tool of tools) {
      expect(tool.outputSchema, tool.name).toMatchObject({ type: "object" });
    }

    const search = await client.callTool({
      name: "search_esi_operations",
      arguments: { query: "server status" },
    });
    expect(search.structuredContent).toMatchObject({ count: 1 });
    const detail = await client.callTool({
      name: "get_esi_operation",
      arguments: { operationId: "GetCharacterAssets" },
    });
    expect(detail.structuredContent).toMatchObject({
      operationId: "GetCharacterAssets",
      authenticated: true,
    });
    const call = await client.callTool({
      name: "call_esi",
      arguments: { operationId: "GetStatus" },
    });
    expect(call.structuredContent).toMatchObject({
      status: 200,
      data: { players: 123 },
      freshness: { fetchedAt: expect.any(String) },
      pagination: { mode: "none" },
    });
    expect(call.structuredContent).not.toHaveProperty("result");
    const callText = call.content.find((block) => block.type === "text");
    if (callText?.type !== "text") throw new Error("Expected ESI result text");
    expect(JSON.parse(callText.text)).toEqual(call.structuredContent);
    const badDetail = await client.callTool({
      name: "get_esi_operation",
      arguments: { operationId: "DeleteEverything" },
    });
    expect(badDetail.isError).toBe(true);
    const badCall = await client.callTool({
      name: "call_esi",
      arguments: { operationId: "DeleteEverything" },
    });
    expect(badCall.isError).toBe(true);
    expect(badCall.structuredContent).toMatchObject({
      code: "UNKNOWN_OPERATION",
      retryable: false,
    });

    const resolved = await client.callTool({
      name: "resolve_eve_entities",
      arguments: { names: ["Tritanium"] },
    });
    expect(resolved.structuredContent).toMatchObject({
      results: [{ status: "resolved", candidates: [{ id: 34 }] }],
    });
    const character = await client.callTool({
      name: "get_character_context",
      arguments: { characterId: 42, sections: ["profile"] },
    });
    expect(character.structuredContent).toMatchObject({
      status: "complete",
      sections: { profile: { status: "ok" } },
    });
    const market = await client.callTool({
      name: "get_market_snapshot",
      arguments: { regionId: 1, typeId: 34, maxPages: 1 },
    });
    expect(market.structuredContent).toMatchObject({
      complete: true,
      pagesFetched: 1,
    });

    const partial = await client.callTool({
      name: "get_character_context",
      arguments: { characterId: 42, sections: ["location", "profile"] },
    });
    expect(partial.isError).not.toBe(true);
    expect(partial.structuredContent).toMatchObject({
      status: "partial",
      sections: {
        location: { status: "error" },
        profile: { status: "ok" },
      },
    });
    const allFailed = await client.callTool({
      name: "get_character_context",
      arguments: { characterId: 42, sections: ["location"] },
    });
    expect(allFailed.isError).toBe(true);
    expect(allFailed.structuredContent).toMatchObject({ status: "failed" });
  });

  it("preserves unwrapped local authorization metadata through the advertised output schemas", async () => {
    const directory = await mkdtemp(join(tmpdir(), "eve-server-auth-"));
    directories.push(directory);
    const store = new CredentialStore(join(directory, "credentials.json"));
    const fetchImplementation = vi.fn<typeof fetch>();
    const login = vi.fn(async (options: SsoLoginOptions) => {
      await store.write(testCredential(options.expectedCharacterId));
    });
    const provider = new InteractiveSsoTokenProvider(
      store,
      "test-client",
      trainingScopes,
      fetchImplementation,
      login,
      testVerifier,
    );
    const catalog = new OperationCatalog(fixtureDocument());
    const client = await connectedClient(
      new EsiClient(catalog, provider, { fetchImplementation }),
      fixtureSource(),
      new CharacterAuthentication(store, provider),
    );
    await client.listTools();
    for (const name of [
      "list_eve_characters",
      "authorize_eve_character",
      "select_eve_character",
    ]) {
      const result = await client.callTool({
        name,
        arguments: name === "list_eve_characters" ? {} : { characterId: 42 },
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toEqual({
        characters:
          name === "list_eve_characters"
            ? []
            : [
                {
                  characterId: 42,
                  characterName: "Test Pilot 42",
                  scopes: trainingScopes,
                },
              ],
        defaultCharacterId: name === "select_eve_character" ? 42 : null,
        legacyCredentialPendingMigration: false,
        browserAuthorizationAvailable: true,
      });
      expect(result.structuredContent).not.toHaveProperty("result");
      const text = result.content.find((block) => block.type === "text");
      if (text?.type !== "text") throw new Error("Expected auth result text");
      expect(JSON.parse(text.text)).toEqual(result.structuredContent);
      expect(JSON.stringify(result)).not.toMatch(
        /refreshToken|accessToken|fake-refresh|test-client/u,
      );
    }
    expect(login).toHaveBeenCalledOnce();
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it("preserves the actual SQLite-backed local cache status fields through MCP after restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "eve-server-status-"));
    directories.push(directory);
    const data = skillFixture();
    const checkedAt = new Date(data.fetchedAt).toISOString();
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            _key: "sde",
            buildNumber: data.buildNumber,
            releaseDate: data.releaseDate,
          }),
        ),
      )
      .mockResolvedValueOnce(new Response("synthetic archive"));
    const readArchive = vi.fn<typeof readStaticArchive>((_path, metadata) =>
      Promise.resolve(
        new SkillImport(directory, metadata).fromCatalog({
          ...data,
          ...metadata,
        }),
      ),
    );
    const options = {
      directory,
      fetchImplementation,
      readArchive,
      now: () => Date.parse(checkedAt),
    };
    (await new StaticDataCache(options).initialize()).release();
    fetchImplementation.mockClear();
    readArchive.mockClear();
    const client = await connectedClient(
      undefined,
      new StaticDataCache(options),
    );
    await client.listTools();
    const result = await client.callTool({
      name: "initialize_static_data",
      arguments: {},
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({
      buildNumber: data.buildNumber,
      releaseDate: data.releaseDate,
      sourceUrl: data.sourceUrl,
      fetchedAt: checkedAt,
      checkedAt,
      stale: false,
      cacheDirectory: directory,
      typeCount: 4,
      skillCount: 3,
    });
    expect(result.structuredContent).not.toHaveProperty("result");
    const text = result.content.find((block) => block.type === "text");
    if (text?.type !== "text") throw new Error("Expected cache status text");
    expect(JSON.parse(text.text)).toEqual(result.structuredContent);
    expect(fetchImplementation).not.toHaveBeenCalled();
    expect(readArchive).not.toHaveBeenCalled();
  });

  it("exposes catalog context and an adventure-planning prompt", async () => {
    const client = await connectedClient();
    const resource = await client.readResource({ uri: "eve-esi://catalog" });
    expect(resource.contents[0]).toMatchObject({
      mimeType: "application/json",
    });
    const catalogContent = resource.contents[0];
    expect(
      catalogContent && "text" in catalogContent ? catalogContent.text : "",
    ).toContain("resolve_eve_entities");
    const prompt = await client.getPrompt({
      name: "plan_eve_adventure",
      arguments: {
        goal: "exploration",
        characterId: "123",
        constraints: "Two hours in high security space",
      },
    });
    expect(prompt.messages[0]?.content).toMatchObject({ type: "text" });
    expect(JSON.stringify(prompt.messages[0]?.content)).toContain(
      "get_character_context",
    );
    expect(JSON.stringify(prompt.messages[0]?.content)).toContain(
      "No activity playbook was selected",
    );

    const miningPrompt = await client.getPrompt({
      name: "plan_eve_adventure",
      arguments: {
        goal: "Use a ship I already own and find something valuable to mine",
        activity: "mining",
        characterId: "123",
      },
    });
    const miningContent = JSON.stringify(miningPrompt.messages[0]?.content);
    expect(miningContent).toContain("Activity playbook: Mining");
    expect(miningContent).toContain("GetCharactersCharacterIdAssets");
    expect(miningContent).toContain("rather than assuming Jita is nearest");

    const factionalWarfarePrompt = await client.getPrompt({
      name: "plan_eve_adventure",
      arguments: {
        goal: "Help me enlist, stage a cheap ship, and earn useful LP",
        activity: "factional_warfare",
        characterId: "123",
      },
    });
    const factionalWarfareContent = JSON.stringify(
      factionalWarfarePrompt.messages[0]?.content,
    );
    expect(factionalWarfareContent).toContain(
      "Activity playbook: Factional warfare",
    );
    expect(factionalWarfareContent).toContain(
      "current in-game Factional Warfare interface",
    );
    expect(factionalWarfareContent).toContain(
      "Frontline, Command Operations, or Rearguard",
    );
    expect(factionalWarfareContent).toContain("estimate net ISK per LP");
  });

  it("rejects an unknown adventure activity", async () => {
    const client = await connectedClient();
    await expect(
      client.getPrompt({
        name: "plan_eve_adventure",
        arguments: { goal: "Try something", activity: "piracy" },
      }),
    ).rejects.toThrow();
  });

  it("discovers and renders character skill planning without ESI or authentication", async () => {
    const fetchImplementation = vi.fn<typeof fetch>();
    const getAccessToken = vi.fn<StaticTokenProvider["getAccessToken"]>();
    const catalog = new OperationCatalog(fixtureDocument());
    const client = await connectedClient(
      new EsiClient(catalog, { getAccessToken }, { fetchImplementation }),
    );
    const { prompts } = await client.listPrompts();
    expect(prompts.map((prompt) => prompt.name)).toEqual(
      expect.arrayContaining(["plan_eve_adventure", "plan_eve_skills"]),
    );
    const metadata = prompts.find(
      (prompt) => prompt.name === "plan_eve_skills",
    );
    expect(metadata?.arguments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "character", required: true }),
        expect.objectContaining({ name: "goal", required: true }),
        expect.objectContaining({ name: "constraints", required: false }),
        expect.objectContaining({ name: "queuePolicy", required: false }),
      ]),
    );
    const prompt = await client.getPrompt({
      name: "plan_eve_skills",
      arguments: {
        character: "Example Pilot",
        goal: "Useful hauling milestones",
      },
    });
    expect(prompt.messages).toHaveLength(1);
    expect(prompt.messages[0]).toMatchObject({
      role: "user",
      content: { type: "text" },
    });
    const content = prompt.messages[0]?.content;
    expect(content?.type).toBe("text");
    if (content?.type !== "text") throw new Error("Expected prompt text");
    expect(JSON.parse(content.text.split("\n\n")[2] ?? "")).toEqual({
      character: "Example Pilot",
      goal: "Useful hauling milestones",
      queuePolicy: "preserve",
    });
    expect(content.text).toContain("Preserve the entire existing queue");
    expect(fetchImplementation).not.toHaveBeenCalled();
    expect(getAccessToken).not.toHaveBeenCalled();
  });

  it("accepts explicit character IDs, constraints and the proposed-reorder policy", async () => {
    const client = await connectedClient();
    const prompt = await client.getPrompt({
      name: "plan_eve_skills",
      arguments: {
        character: "123",
        goal: "Exploration",
        constraints: "Alpha; no spending",
        queuePolicy: "reorder",
      },
    });
    const content = prompt.messages[0]?.content;
    if (content?.type !== "text") throw new Error("Expected prompt text");
    expect(JSON.parse(content.text.split("\n\n")[2] ?? "")).toEqual({
      character: "123",
      goal: "Exploration",
      constraints: "Alpha; no spending",
      queuePolicy: "reorder",
    });
    expect(content.text).toContain("Propose a reordered queue");
    expect(content.text).not.toContain("Preserve the entire existing queue");
    expect(content.text).toContain("This is advice only");
  });

  it.each([
    { goal: "Hauling" },
    { character: "123" },
    { character: " ", goal: "Hauling" },
    { character: "123", goal: " " },
    { character: "123", goal: "Hauling", queuePolicy: "discard" },
  ])(
    "rejects incomplete or invalid skill-plan arguments: %j",
    async (arguments_) => {
      const client = await connectedClient();
      await expect(
        client.getPrompt({ name: "plan_eve_skills", arguments: arguments_ }),
      ).rejects.toThrow();
    },
  );

  it("rejects invalid strict workflow inputs through MCP", async () => {
    const client = await connectedClient();
    const both = await client.callTool({
      name: "resolve_eve_entities",
      arguments: { names: ["A"], ids: [1] },
    });
    expect(both.isError).toBe(true);
    const neither = await client.callTool({
      name: "resolve_eve_entities",
      arguments: {},
    });
    expect(neither.isError).toBe(true);
    const oversize = await client.callTool({
      name: "resolve_eve_entities",
      arguments: {
        names: Array.from({ length: 501 }, (_, index) => `N${index}`),
      },
    });
    expect(oversize.isError).toBe(true);
    const duplicateSections = await client.callTool({
      name: "get_character_context",
      arguments: { characterId: 42, sections: ["profile", "profile"] },
    });
    expect(duplicateSections.isError).toBe(true);
    const unknownField = await client.callTool({
      name: "get_market_snapshot",
      arguments: { regionId: 1, typeId: 34, surprise: true },
    });
    expect(unknownField.isError).toBe(true);
  });

  it("serves the public cache and dependency graph through MCP without SSO", async () => {
    const client = await connectedClient();
    const cache = await client.callTool({
      name: "initialize_static_data",
      arguments: { refresh: true },
    });
    expect(cache.structuredContent).toMatchObject({
      buildNumber: 123,
      stale: false,
    });
    const targets = await client.callTool({
      name: "resolve_skill_plan_targets",
      arguments: { targets: ["exhumer", "Mining II"] },
    });
    expect(targets.structuredContent).toMatchObject({
      targets: [
        { status: "resolved", typeId: 200 },
        { status: "resolved", typeId: 100 },
      ],
    });
    const dependencies = await client.callTool({
      name: "get_skill_dependencies",
      arguments: { target: "Test Hull" },
    });
    expect(dependencies.structuredContent).toMatchObject({
      status: "complete",
      graph: { nodes: expect.any(Array), edges: expect.any(Array) },
    });
    const unknown = await client.callTool({
      name: "generate_skill_plan",
      arguments: { characterId: 42, target: "unknown" },
    });
    expect(unknown.structuredContent).toMatchObject({
      status: "needs_target_selection",
    });
    expect(unknown.isError).not.toBe(true);
  });

  it("generates personalized training through MCP with actual ESI validation and authorization", async () => {
    const catalog = new OperationCatalog(
      JSON.parse(
        readFileSync(
          new URL("../lib/openapi/esi-openapi.json", import.meta.url),
          "utf8",
        ),
      ) as OpenApiDocument,
    );
    const tokenProvider = new StaticTokenProvider(
      `h.${Buffer.from(JSON.stringify({ sub: "CHARACTER:EVE:42", scp: ["esi-skills.read_skills.v1", "esi-skills.read_skillqueue.v1"] })).toString("base64url")}.s`,
    );
    const fetcher = vi.fn<typeof fetch>().mockImplementation((url) => {
      const href =
        url instanceof URL ? url.href : typeof url === "string" ? url : url.url;
      if (href.includes("/skills"))
        return Promise.resolve(
          new Response(
            JSON.stringify({
              skills: [
                {
                  skill_id: 100,
                  trained_skill_level: 1,
                  active_skill_level: 1,
                  skillpoints_in_skill: 250,
                },
              ],
              total_sp: 250,
            }),
          ),
        );
      if (href.includes("/skillqueue"))
        return Promise.resolve(new Response("[]"));
      throw new Error("Unexpected URL");
    });
    const esi = new EsiClient(catalog, tokenProvider, {
      fetchImplementation: fetcher,
    });
    const client = await connectedClient(esi);
    const result = await client.callTool({
      name: "generate_skill_plan",
      arguments: { characterId: 42, target: "Mining II" },
    });
    expect(result.isError, JSON.stringify(result.structuredContent)).not.toBe(
      true,
    );
    expect(result.structuredContent).toMatchObject({
      status: "complete",
      trainingText: "Mining II",
      additionalSkillPointsEstimate: 1165,
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("reports cache failure consistently across all planning tools", async () => {
    const source = fixtureSource();
    vi.spyOn(source, "initialize").mockRejectedValue(
      new Error("Static data unavailable"),
    );
    const client = await connectedClient(undefined, source);
    for (const name of [
      "initialize_static_data",
      "resolve_skill_plan_targets",
      "get_skill_dependencies",
      "generate_skill_plan",
    ]) {
      const result = await client.callTool({
        name,
        arguments:
          name === "initialize_static_data"
            ? {}
            : name === "generate_skill_plan"
              ? { characterId: 42, target: "Mining II" }
              : { target: "Mining II" },
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain(
        "Static data unavailable",
      );
    }
  });

  it.each([
    [42, ["esi-skills.read_skills.v1"], "MISSING_SCOPES"],
    [
      43,
      ["esi-skills.read_skills.v1", "esi-skills.read_skillqueue.v1"],
      "CHARACTER_MISMATCH",
    ],
  ])(
    "requires both private scopes and the intended character before ESI access: %j",
    async (id, scopes, code) => {
      const catalog = new OperationCatalog(fixtureDocument());
      const fetcher = vi.fn<typeof fetch>();
      const token = new StaticTokenProvider(
        `h.${Buffer.from(JSON.stringify({ sub: `CHARACTER:EVE:${id}`, scp: scopes })).toString("base64url")}.s`,
      );
      const client = await connectedClient(
        new EsiClient(catalog, token, { fetchImplementation: fetcher }),
      );
      const result = await client.callTool({
        name: "generate_skill_plan",
        arguments: { characterId: 42, target: "Mining II" },
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({ code });
      expect(fetcher).not.toHaveBeenCalled();
    },
  );

  it.each([
    {},
    { target: "Mining", targets: ["Mining"] },
    { target: "" },
    { targets: [] },
    { target: { typeId: 100, level: 6 } },
    { target: "Mining", surprise: true },
    { targets: Array.from({ length: 51 }, () => "Mining") },
  ])("rejects invalid planning targets over MCP: %j", async (arguments_) => {
    const client = await connectedClient();
    for (const name of [
      "resolve_skill_plan_targets",
      "get_skill_dependencies",
      "generate_skill_plan",
    ]) {
      expect(
        (
          await client.callTool({
            name,
            arguments:
              name === "generate_skill_plan"
                ? { ...arguments_, characterId: 42 }
                : arguments_,
          })
        ).isError,
      ).toBe(true);
    }
  });

  it("requires an explicit character and valid queue policy for a personalized plan", async () => {
    const client = await connectedClient();
    for (const arguments_ of [
      { target: "Mining II" },
      { characterId: 0, target: "Mining II" },
      { characterId: 42, target: "Mining II", queuePolicy: "discard" },
    ]) {
      expect(
        (
          await client.callTool({
            name: "generate_skill_plan",
            arguments: arguments_,
          })
        ).isError,
      ).toBe(true);
    }
  });
});
