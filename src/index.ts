#!/usr/bin/env node
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import {
  DEFAULT_EVE_CLIENT_ID,
  InteractiveSsoTokenProvider,
  tokenProviderFromEnvironment,
} from "./auth.js";
import { CharacterAuthentication } from "./character-authentication.js";
import { CredentialStore } from "./credential-store.js";
import { runAuthCommand } from "./cli.js";
import { EsiClient } from "./esi-client.js";
import { loadOpenApiDocument, OperationCatalog } from "./openapi.js";
import { createEveServer } from "./server.js";
import { StaticDataCache } from "./static-data.js";
import { localTelemetry } from "./telemetry.js";

const document = await loadOpenApiDocument();
const catalog = new OperationCatalog(document);
if (await runAuthCommand(process.argv.slice(2), catalog)) process.exit(0);
const scopes = [
  ...new Set(
    catalog.operations.flatMap((operation) => operation.requiredScopes),
  ),
].sort();
const tokenProvider = tokenProviderFromEnvironment(process.env, fetch, {
  scopes,
  interactive: process.env.EVE_DISABLE_AUTO_SSO !== "1",
});
const client = new EsiClient(catalog, tokenProvider, {
  ...(process.env.ESI_USER_AGENT
    ? { userAgent: process.env.ESI_USER_AGENT }
    : {}),
  ...(process.env.ESI_MAX_RESPONSE_BYTES
    ? { maxResponseBytes: Number(process.env.ESI_MAX_RESPONSE_BYTES) }
    : {}),
});

const store = new CredentialStore();
const interactive =
  tokenProvider instanceof InteractiveSsoTokenProvider
    ? tokenProvider
    : process.env.EVE_ACCESS_TOKEN ||
        (process.env.EVE_CLIENT_ID && process.env.EVE_REFRESH_TOKEN)
      ? undefined
      : new InteractiveSsoTokenProvider(
          store,
          process.env.EVE_CLIENT_ID ?? DEFAULT_EVE_CLIENT_ID,
          scopes,
          fetch,
          undefined,
          undefined,
          process.env.EVE_SSO_REDIRECT_URI,
        );
const authentication = new CharacterAuthentication(store, interactive);
const staticData = new StaticDataCache();
// Keep the MCP handshake responsive during the first download. Planning awaits this initialization.
void staticData.initialize().catch(() => {
  console.error(
    "eve-online-mcp: static data initialization failed; retry initialize_static_data.",
  );
});

const telemetry = await localTelemetry();
const factory = () =>
  createEveServer(catalog, client, authentication, staticData);
const start = () =>
  serveStdio(() => (telemetry ? telemetry.run(factory) : factory()), {
    onerror: () => {
      console.error("eve-online-mcp: MCP transport error");
    },
  });
const handle = telemetry ? telemetry.run(start) : start();
let closing: Promise<void> | undefined;
const close = () =>
  (closing ??= handle.close().finally(() => telemetry?.close()));
process.stdin.once("end", () => {
  void close();
});
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    void close().finally(() => {
      process.exit(0);
    });
  });
