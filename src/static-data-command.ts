import { StaticDataCache, type StaticDataSource } from "./static-data.js";

/** Explicit operator command; normal MCP tools manage initialization themselves. */
export async function runStaticDataCommand(
  args: string[],
  source: StaticDataSource = new StaticDataCache(),
  write: (text: string) => void = console.log,
) {
  if (args[0] !== "static-data") return false;
  if (args.length !== 2 || args[1] !== "refresh")
    throw new Error("Usage: eve-online-mcp static-data refresh");
  const snapshot = await source.initialize(true);
  try {
    write(JSON.stringify(snapshot.status));
  } finally {
    snapshot.release?.();
  }
  return true;
}
