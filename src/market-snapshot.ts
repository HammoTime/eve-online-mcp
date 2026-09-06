import {
  EsiRequestError,
  publicEsiError,
  type EsiClient,
} from "./esi-client.js";
import type { JsonValue } from "./types.js";
import { sourceMetadata } from "./workflow-common.js";

interface MarketOrder {
  orderId: number;
  typeId: number;
  locationId: number;
  volumeRemain: number;
  price: number;
  isBuyOrder: boolean;
  original: Record<string, JsonValue>;
}

const MARKET_CAVEAT =
  "Observed prices are from separately fetched public regional pages. Buy-order range, minimum volume, location access, and later market changes can prevent execution; observed spread is not guaranteed profit.";

function invalidPage(message: string): EsiRequestError {
  return new EsiRequestError(message, undefined, undefined, {
    code: "INVALID_UPSTREAM_RESPONSE",
    retryable: false,
  });
}

function responseLimit(limit: number): EsiRequestError {
  return new EsiRequestError(
    `Market collection exceeds the ${limit} byte aggregate raw-data limit`,
    undefined,
    undefined,
    { code: "RESPONSE_LIMIT", retryable: false },
  );
}

function asOrder(value: JsonValue, page: number): MarketOrder {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw invalidPage(`Market page ${page} contains a non-object order`);
  const orderId = value.order_id;
  const typeId = value.type_id;
  const locationId = value.location_id;
  const volumeRemain = value.volume_remain;
  const price = value.price;
  const isBuyOrder = value.is_buy_order;
  if (
    typeof orderId !== "number" ||
    !Number.isSafeInteger(orderId) ||
    orderId <= 0 ||
    typeof typeId !== "number" ||
    !Number.isSafeInteger(typeId) ||
    typeId <= 0 ||
    typeof locationId !== "number" ||
    !Number.isSafeInteger(locationId) ||
    locationId <= 0 ||
    typeof volumeRemain !== "number" ||
    !Number.isSafeInteger(volumeRemain) ||
    volumeRemain < 0 ||
    typeof price !== "number" ||
    !Number.isFinite(price) ||
    price < 0 ||
    typeof isBuyOrder !== "boolean"
  )
    throw invalidPage(`Market page ${page} contains a malformed order`);
  return {
    orderId,
    typeId,
    locationId,
    volumeRemain,
    price,
    isBuyOrder,
    original: value,
  };
}

function parsePage(
  data: JsonValue | string | null,
  page: number,
): MarketOrder[] {
  if (!Array.isArray(data))
    throw invalidPage(`Market page ${page} did not return an order array`);
  return data.map((value) => asOrder(value, page));
}

export async function getMarketSnapshot(
  client: EsiClient,
  input: {
    regionId: number;
    typeId: number;
    locationId?: number;
    maxPages: number;
  },
  options: { maxAggregateBytes?: number } = {},
): Promise<Record<string, unknown>> {
  const maxAggregateBytes = options.maxAggregateBytes ?? 5_000_000;
  const sources: Record<string, unknown>[] = [];
  const warnings = [MARKET_CAVEAT];
  const orders = new Map<number, MarketOrder>();
  let page = 1;
  let aggregateBytes = 0;
  let observedPageCount: number | null = null;
  let stopReason = "allPagesFetched";
  let inconsistent = false;

  for (;;) {
    let response;
    try {
      response = await client.call({
        operationId: "GetMarketsRegionIdOrders",
        path: { region_id: input.regionId },
        query: {
          order_type: "all",
          type_id: input.typeId,
          page,
        },
      });
    } catch (error) {
      if (page === 1) throw error;
      stopReason = "pageError";
      warnings.push(
        `Page ${page} failed: ${JSON.stringify(publicEsiError(error))}`,
      );
      break;
    }

    const pageBytes = client.responseByteLength(response);
    if (aggregateBytes + pageBytes > maxAggregateBytes) {
      if (page === 1) throw responseLimit(maxAggregateBytes);
      stopReason = "byteLimit";
      warnings.push(`Page ${page} was not accepted because of the byte limit.`);
      break;
    }

    let pageOrders: MarketOrder[];
    try {
      pageOrders = parsePage(response.data, page);
    } catch (error) {
      if (page === 1) throw error;
      stopReason = "invalidPage";
      warnings.push(
        `Page ${page} was not accepted: ${JSON.stringify(publicEsiError(error))}`,
      );
      break;
    }

    aggregateBytes += pageBytes;
    sources.push({ page, ...sourceMetadata(response) });
    for (const order of pageOrders) {
      const existing = orders.get(order.orderId);
      if (!existing) {
        orders.set(order.orderId, order);
      } else if (
        JSON.stringify(existing.original) !== JSON.stringify(order.original)
      ) {
        inconsistent = true;
        warnings.push(
          `Conflicting duplicate order_id ${order.orderId} on page ${page}; the first occurrence was retained.`,
        );
      }
    }

    const reportedPages = response.pagination.totalPages;
    if (observedPageCount === null) {
      observedPageCount = reportedPages;
      if (reportedPages === null) {
        stopReason = "unknownPageCount";
        break;
      }
    } else if (reportedPages === null || reportedPages !== observedPageCount) {
      inconsistent = true;
      stopReason = "pageCountChanged";
      warnings.push(
        `Reported page count changed from ${observedPageCount} to ${reportedPages ?? "unknown"}.`,
      );
      break;
    }
    if (observedPageCount !== null && page >= observedPageCount) break;
    if (sources.length >= input.maxPages) {
      stopReason = "maxPages";
      break;
    }
    page += 1;
  }

  const filtered = [...orders.values()].filter(
    (order) =>
      order.typeId === input.typeId &&
      (input.locationId === undefined || order.locationId === input.locationId),
  );
  const buyOrders = filtered.filter((order) => order.isBuyOrder);
  const sellOrders = filtered.filter((order) => !order.isBuyOrder);
  const highestObservedBuy =
    buyOrders.length === 0
      ? null
      : Math.max(...buyOrders.map((order) => order.price));
  const lowestObservedSell =
    sellOrders.length === 0
      ? null
      : Math.min(...sellOrders.map((order) => order.price));
  if (stopReason === "allPagesFetched" && inconsistent)
    stopReason = "inconsistentData";
  const complete = stopReason === "allPagesFetched" && !inconsistent;

  return {
    regionId: input.regionId,
    typeId: input.typeId,
    locationId: input.locationId ?? null,
    scope: "public regional market orders only",
    pagesFetched: sources.length,
    observedPageCount,
    complete,
    stopReason,
    warnings,
    sources,
    aggregates: {
      buyOrderCount: buyOrders.length,
      sellOrderCount: sellOrders.length,
      buyVolumeRemaining: buyOrders.reduce(
        (total, order) => total + order.volumeRemain,
        0,
      ),
      sellVolumeRemaining: sellOrders.reduce(
        (total, order) => total + order.volumeRemain,
        0,
      ),
      highestObservedBuy,
      lowestObservedSell,
      observedSpread:
        highestObservedBuy === null || lowestObservedSell === null
          ? null
          : lowestObservedSell - highestObservedBuy,
    },
  };
}
