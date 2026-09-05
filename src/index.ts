#!/usr/bin/env node
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { tokenProviderFromEnvironment } from "./auth.js";
import { runAuthCommand } from "./cli.js";
import { EsiClient } from "./esi-client.js";
import { loadOpenApiDocument, OperationCatalog } from "./openapi.js";
import { createEveServer } from "./server.js";

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

serveStdio(() => createEveServer(catalog, client), {
  onerror: (error) => {
    console.error("eve-online-mcp:", error.message);
  },
});
