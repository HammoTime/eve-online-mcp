import type { EsiResponse } from "./esi-client.js";

export function sourceMetadata(response: EsiResponse): Record<string, unknown> {
  return {
    operationId: response.operationId,
    status: response.status,
    url: response.url,
    cached: response.cached,
    headers: response.headers,
    freshness: response.freshness,
    pagination: response.pagination,
  };
}
