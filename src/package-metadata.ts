import { readFileSync } from "node:fs";

interface PackageMetadata {
  name: string;
  version: string;
}

const packageMetadata = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as PackageMetadata;

const CONTACT = "adam@hammo.dev; +https://github.com/HammoTime/eve-online-mcp";

export const DEFAULT_ESI_USER_AGENT = `${packageMetadata.name}/${packageMetadata.version} (${CONTACT})`;

export const SCHEMA_CHECK_USER_AGENT = `${packageMetadata.name}-schema-check/${packageMetadata.version} (${CONTACT})`;
