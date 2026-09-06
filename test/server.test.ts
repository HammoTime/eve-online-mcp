import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StaticTokenProvider } from "../src/auth.js";
import { EsiClient } from "../src/esi-client.js";
import { OperationCatalog } from "../src/openapi.js";
import { createEveServer } from "../src/server.js";
import { fixtureDocument } from "./fixtures.js";

const connections: { close(): Promise<void> }[] = [];
afterEach(async () =>
  Promise.all(connections.splice(0).map(async (value) => value.close())),
);

async function connectedClient() {
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
  const server = createEveServer(catalog, esiClient);
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  connections.push(client, server);
  return client;
}

describe("EVE MCP server", () => {
  it("exposes the discovery and call tools over MCP", async () => {
    const client = await connectedClient();
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual([
      "search_esi_operations",
      "get_esi_operation",
      "call_esi",
      "resolve_eve_entities",
      "get_character_context",
      "get_market_snapshot",
    ]);

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
  });

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
});
