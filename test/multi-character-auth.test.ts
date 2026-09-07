import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { InteractiveSsoTokenProvider } from "../src/auth.js";
import { CharacterAuthentication } from "../src/character-authentication.js";
import { CredentialStore } from "../src/credential-store.js";
import { EsiClient } from "../src/esi-client.js";
import { loadOpenApiDocument, OperationCatalog } from "../src/openapi.js";
import { createEveServer } from "../src/server.js";
import type { SsoLoginOptions } from "../src/sso.js";
import {
  testCredential,
  testToken,
  testVerifier,
  trainingScopes,
} from "./auth-fixtures.js";

let catalog: OperationCatalog;
const directories: string[] = [];
const connections: { close(): Promise<void> }[] = [];
beforeAll(async () => {
  catalog = new OperationCatalog(await loadOpenApiDocument());
});
afterEach(async () => {
  await Promise.all(
    connections.splice(0).map((connection) => connection.close()),
  );
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "eve-multi-auth-"));
  directories.push(directory);
  const store = new CredentialStore(join(directory, "credentials.json"));
  const login = vi.fn(async (options: SsoLoginOptions) => {
    await store.write(testCredential(options.expectedCharacterId));
  });
  const refresh = vi.fn<typeof fetch>((_url, init) => {
    const refreshToken =
      (init?.body as URLSearchParams).get("refresh_token") ?? "";
    const characterId = Number(refreshToken.split("-")[2]);
    return Promise.resolve(
      new Response(
        JSON.stringify({
          access_token: testToken(characterId),
          refresh_token: `${refreshToken}-rotated`,
          expires_in: 1200,
        }),
      ),
    );
  });
  const provider = new InteractiveSsoTokenProvider(
    store,
    "test-client",
    trainingScopes,
    refresh,
    login,
    testVerifier,
  );
  const esiFetch = vi.fn<typeof fetch>((url, init) => {
    const path = new URL(url instanceof Request ? url.url : url).pathname;
    const characterId = Number(path.split("/")[2]);
    const protectedRequest = /skills|skillqueue/u.test(path);
    expect(new Headers(init?.headers).get("authorization")).toBe(
      protectedRequest ? `Bearer ${testToken(characterId)}` : null,
    );
    return Promise.resolve(
      new Response(JSON.stringify({ characterId }), {
        headers: { "cache-control": "max-age=60" },
      }),
    );
  });
  const esi = new EsiClient(catalog, provider, {
    fetchImplementation: esiFetch,
  });
  const server = createEveServer(
    catalog,
    esi,
    new CharacterAuthentication(store, provider),
  );
  const client = new Client({ name: "test-client", version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  connections.push(server, client);
  return { client, store, provider, login, refresh, esiFetch };
}

describe("multi-character authentication through MCP", () => {
  it("does not launch login or change defaults through management tools in environment override mode", async () => {
    const { store } = await setup();
    const management = new CharacterAuthentication(store);
    expect(await management.list()).toMatchObject({
      browserAuthorizationAvailable: false,
    });
    await expect(management.authorize(42)).rejects.toThrow(
      "environment token overrides",
    );
    await expect(management.select(42)).rejects.toThrow(
      "environment token overrides",
    );
  });
  it("automatically logs in each missing character and retrieves both skills and queues without commands", async () => {
    const { client, store, login, refresh } = await setup();
    const profile = await client.callTool({
      name: "get_character_context",
      arguments: { characterId: 42, sections: ["profile"] },
    });
    expect(profile.structuredContent).toMatchObject({ status: "complete" });
    expect(login).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
    for (const characterId of [42, 43, 42]) {
      const result = await client.callTool({
        name: "get_character_context",
        arguments: { characterId, sections: ["skills", "skillQueue"] },
      });
      expect(result.structuredContent).toMatchObject({
        status: "complete",
        sections: {
          skills: { data: { characterId } },
          skillQueue: { data: { characterId } },
        },
      });
      expect(JSON.stringify(result)).not.toContain("fake-refresh");
    }
    expect(
      login.mock.calls.map(([options]) => options.expectedCharacterId),
    ).toEqual([42, 43]);
    expect(refresh).toHaveBeenCalledTimes(2);
    const direct = await client.callTool({
      name: "call_esi",
      arguments: {
        operationId: "GetCharactersCharacterIdSkills",
        path: { character_id: 43 },
      },
    });
    expect(direct.structuredContent).toMatchObject({
      data: { characterId: 43 },
    });
    expect((await store.read()).characters).toHaveLength(2);
  });

  it("lists safe metadata, renews consent, and selects a default entirely through MCP", async () => {
    const { client, login, store } = await setup();
    expect(
      (await client.callTool({ name: "list_eve_characters", arguments: {} }))
        .structuredContent,
    ).toMatchObject({ characters: [] });
    const result = await client.callTool({
      name: "authorize_eve_character",
      arguments: { characterId: 43 },
    });
    expect(result.structuredContent).toMatchObject({
      characters: [
        {
          characterId: 43,
          characterName: "Test Pilot 43",
          scopes: trainingScopes,
        },
      ],
    });
    expect(JSON.stringify(result)).not.toMatch(
      /refreshToken|accessToken|fake-refresh|test-client/u,
    );
    expect(login).toHaveBeenCalledOnce();
    const selected = await client.callTool({
      name: "select_eve_character",
      arguments: { characterId: 43 },
    });
    expect(selected.structuredContent).toMatchObject({
      defaultCharacterId: 43,
    });
    expect((await store.read()).defaultCharacterId).toBe(43);
    expect(
      (
        await client.callTool({
          name: "select_eve_character",
          arguments: { characterId: 99 },
        })
      ).isError,
    ).toBe(true);
  });

  it("reports failed consent for the requested character while public data still succeeds", async () => {
    const { client, login } = await setup();
    login.mockRejectedValueOnce(new Error("consent declined"));
    const result = await client.callTool({
      name: "get_character_context",
      arguments: {
        characterId: 43,
        sections: ["profile", "skills", "skillQueue"],
      },
    });
    expect(result.structuredContent).toMatchObject({
      status: "partial",
      sections: {
        profile: { status: "ok" },
        skills: {
          error: {
            code: "AUTHENTICATION_FAILED",
            details: { characterId: 43 },
          },
        },
        skillQueue: { error: { details: { characterId: 43 } } },
      },
    });
    expect(login).toHaveBeenCalledOnce();
  });
});
