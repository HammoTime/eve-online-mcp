import { createEveServer as createSharedEveServer } from "../lib/src/server.js";
import type { OperationCatalog } from "./openapi.js";
import type { EsiClient } from "./esi-client.js";
import type { CharacterAuthentication } from "./character-authentication.js";
import { StaticDataCache, type StaticDataSource } from "./static-data.js";
import { PACKAGE_VERSION } from "./package-metadata.js";

export function createEveServer(
  catalog: OperationCatalog,
  client: EsiClient,
  authentication?: CharacterAuthentication,
  staticData: StaticDataSource = new StaticDataCache(),
) {
  return createSharedEveServer(catalog, client, {
    identity: { name: "eve-online-mcp", version: PACKAGE_VERSION },
    staticData,
    ...(authentication ? { authentication } : {}),
  });
}
