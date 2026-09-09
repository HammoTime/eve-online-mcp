import { createEveServer as createSharedEveServer } from "../lib/src/server.js";
import type { OperationCatalog } from "./openapi.js";
import type { EsiClient } from "./esi-client.js";
import type { CharacterAuthentication } from "./character-authentication.js";
import { StaticDataCache, type StaticDataSource } from "./static-data.js";
import { PACKAGE_VERSION } from "./package-metadata.js";
import { LocalMapDataSource } from "./map-data.js";
import { LocalMapArtifacts } from "./map-artifacts.js";
import { LocalMapPreview } from "./map-preview.js";
import type { CartographyServices } from "../lib/src/cartography/service.js";

export function createEveServer(
  catalog: OperationCatalog,
  client: EsiClient,
  authentication?: CharacterAuthentication,
  staticData: StaticDataSource = new StaticDataCache(),
  cartography: CartographyServices = {
    data: new LocalMapDataSource(),
    artifacts: new LocalMapArtifacts(),
    preview: new LocalMapPreview(),
  },
) {
  return createSharedEveServer(catalog, client, {
    identity: { name: "eve-online-mcp", version: PACKAGE_VERSION },
    staticData,
    cartography,
    ...(authentication ? { authentication } : {}),
  });
}
