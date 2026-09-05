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
      .mockResolvedValue(
        new Response(JSON.stringify({ players: 123 }), { status: 200 }),
      ),
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
  });

  it("exposes catalog context and an adventure-planning prompt", async () => {
    const client = await connectedClient();
    const resource = await client.readResource({ uri: "eve-esi://catalog" });
    expect(resource.contents[0]).toMatchObject({
      mimeType: "application/json",
    });
    const prompt = await client.getPrompt({
      name: "plan_eve_adventure",
      arguments: {
        goal: "exploration",
        characterId: "123",
        constraints: "Two hours in high security space",
      },
    });
    expect(prompt.messages[0]?.content).toMatchObject({ type: "text" });
  });
});
