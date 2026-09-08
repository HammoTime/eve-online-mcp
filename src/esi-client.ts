import { EsiClient as SharedEsiClient } from "../lib/src/esi-client.js";
import { DEFAULT_ESI_USER_AGENT } from "./package-metadata.js";
export * from "../lib/src/esi-client.js";

export class EsiClient extends SharedEsiClient {
  constructor(
    catalog: ConstructorParameters<typeof SharedEsiClient>[0],
    tokenProvider: ConstructorParameters<typeof SharedEsiClient>[1],
    options: ConstructorParameters<typeof SharedEsiClient>[2] = {},
  ) {
    super(catalog, tokenProvider, {
      userAgent: DEFAULT_ESI_USER_AGENT,
      ...options,
    });
  }
}
