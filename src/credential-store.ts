import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface StoredCredential {
  clientId: string;
  refreshToken: string;
  scopes: string[];
  createdAt: string;
}

export function defaultCredentialPath(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  if (environment.EVE_CREDENTIALS_PATH) return environment.EVE_CREDENTIALS_PATH;
  const configRoot = environment.APPDATA ?? join(homedir(), ".config");
  return join(configRoot, "eve-online-mcp", "credentials.json");
}

export class CredentialStore {
  constructor(readonly path = defaultCredentialPath()) {}

  async read(): Promise<StoredCredential | undefined> {
    try {
      const value = JSON.parse(await readFile(this.path, "utf8")) as unknown;
      if (
        typeof value !== "object" ||
        value === null ||
        !("clientId" in value) ||
        typeof value.clientId !== "string" ||
        !("refreshToken" in value) ||
        typeof value.refreshToken !== "string" ||
        !("scopes" in value) ||
        !Array.isArray(value.scopes) ||
        !value.scopes.every((scope) => typeof scope === "string") ||
        !("createdAt" in value) ||
        typeof value.createdAt !== "string"
      ) {
        throw new Error(`Invalid EVE credential file: ${this.path}`);
      }
      return value as StoredCredential;
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return undefined;
      }
      throw error;
    }
  }

  async write(credential: StoredCredential): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    await writeFile(this.path, `${JSON.stringify(credential, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await chmod(this.path, 0o600);
  }

  async remove(): Promise<boolean> {
    try {
      await rm(this.path);
      return true;
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return false;
      }
      throw error;
    }
  }
}
