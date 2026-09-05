import { DEFAULT_EVE_CLIENT_ID } from "./auth.js";
import { CredentialStore } from "./credential-store.js";
import { loginWithEveSso } from "./sso.js";
import type { OperationCatalog } from "./openapi.js";

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function requestedScopes(args: string[], catalog: OperationCatalog): string[] {
  const supplied = option(args, "--scopes");
  if (supplied) return supplied.split(/[\s,]+/u).filter(Boolean);
  return [
    ...new Set(
      catalog.operations.flatMap((operation) => operation.requiredScopes),
    ),
  ].sort();
}

export async function runAuthCommand(
  args: string[],
  catalog: OperationCatalog,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  if (args[0] !== "auth") return false;
  const store = new CredentialStore(environment.EVE_CREDENTIALS_PATH);
  const command = args[1];
  if (command === "login") {
    const clientId =
      option(args, "--client-id") ??
      environment.EVE_CLIENT_ID ??
      DEFAULT_EVE_CLIENT_ID;
    const redirectUri =
      option(args, "--redirect-uri") ?? environment.EVE_SSO_REDIRECT_URI;
    const result = await loginWithEveSso({
      clientId,
      scopes: requestedScopes(args, catalog),
      store,
      ...(redirectUri ? { redirectUri } : {}),
    });
    console.log(
      `EVE SSO login complete. Stored a refresh credential at ${result.credentialPath}.`,
    );
    return true;
  }
  if (command === "status") {
    const credential = await store.read();
    console.log(
      credential
        ? `EVE SSO is configured for client ${credential.clientId} with ${credential.scopes.length} scopes.`
        : "EVE SSO is not configured. Public ESI operations remain available.",
    );
    return true;
  }
  if (command === "logout") {
    console.log(
      (await store.remove())
        ? "Removed the locally stored EVE SSO credential."
        : "No locally stored EVE SSO credential was found.",
    );
    return true;
  }
  throw new Error("Usage: eve-online-mcp auth <login|status|logout>");
}
