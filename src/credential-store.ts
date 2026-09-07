import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";

const legacySchema = z
  .object({
    clientId: z.string().min(1),
    refreshToken: z.string().min(1),
    scopes: z.array(z.string()),
    createdAt: z.string().min(1),
  })
  .strict();
const characterSchema = legacySchema
  .extend({
    characterId: z.number().int().positive(),
    characterName: z.string().min(1),
  })
  .strict();
const fileSchema = z
  .object({
    version: z.literal(2),
    characters: z.array(characterSchema),
    defaultCharacterId: z.number().int().positive().optional(),
    legacyCredential: legacySchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const ids = value.characters.map((character) => character.characterId);
    if (
      new Set(ids).size !== ids.length ||
      (value.defaultCharacterId !== undefined &&
        !ids.includes(value.defaultCharacterId))
    ) {
      context.addIssue({
        code: "custom",
        message: "Duplicate character or invalid default character",
      });
    }
  });

export type StoredCredential = z.infer<typeof legacySchema>;
export type CharacterCredential = z.infer<typeof characterSchema>;
export type CredentialFile = z.infer<typeof fileSchema>;

export function defaultCredentialPath(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  if (environment.EVE_CREDENTIALS_PATH) return environment.EVE_CREDENTIALS_PATH;
  return join(
    environment.APPDATA ?? join(homedir(), ".config"),
    "eve-online-mcp",
    "credentials.json",
  );
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

export class CredentialStore {
  constructor(readonly path = defaultCredentialPath()) {}

  async read(): Promise<CredentialFile> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (error) {
      if (hasCode(error, "ENOENT")) return { version: 2, characters: [] };
      throw error;
    }
    // Never include parser diagnostics: they can quote credential contents.
    try {
      const value: unknown = JSON.parse(raw);
      const legacy = legacySchema.safeParse(value);
      if (legacy.success)
        return { version: 2, characters: [], legacyCredential: legacy.data };
      return fileSchema.parse(value);
    } catch {
      throw new Error(
        "Invalid EVE credential file; repair it or log out before signing in again.",
      );
    }
  }

  async withRefreshLock<T>(
    key: number | "legacy",
    action: () => Promise<T>,
  ): Promise<T> {
    return this.lock(`.refresh-${key}.lock`, action);
  }

  async write(credential: CharacterCredential): Promise<void> {
    const parsed = characterSchema.safeParse(credential);
    if (!parsed.success) throw new Error("Invalid EVE character credential.");
    await this.update((file) => {
      this.upsert(file, parsed.data);
    });
  }

  async migrateLegacy(
    previous: StoredCredential,
    credential: CharacterCredential,
  ): Promise<void> {
    await this.update((file) => {
      if (file.legacyCredential?.refreshToken !== previous.refreshToken) return;
      // A newer explicit login for this character takes precedence.
      if (
        !file.characters.some(
          (entry) => entry.characterId === credential.characterId,
        )
      )
        this.upsert(file, credential);
      delete file.legacyCredential;
    });
  }

  async rotate(
    previous: CharacterCredential,
    refreshToken: string,
  ): Promise<void> {
    await this.update((file) => {
      const current = file.characters.find(
        (entry) => entry.characterId === previous.characterId,
      );
      if (
        current?.refreshToken !== previous.refreshToken ||
        current.clientId !== previous.clientId
      )
        throw new Error(
          `Credential for character ${previous.characterId} changed during refresh; retry the operation.`,
        );
      current.refreshToken = refreshToken;
    });
  }

  async select(characterId: number): Promise<void> {
    await this.update((file) => {
      if (!file.characters.some((entry) => entry.characterId === characterId))
        throw new Error(`No saved authorization for character ${characterId}.`);
      file.defaultCharacterId = characterId;
    });
  }

  async remove(characterId?: number): Promise<boolean> {
    return this.lock(".lock", async () => {
      if (characterId === undefined) {
        try {
          await rm(this.path);
          return true;
        } catch (error) {
          if (hasCode(error, "ENOENT")) return false;
          throw error;
        }
      }
      const file = await this.read();
      const count = file.characters.length;
      file.characters = file.characters.filter(
        (entry) => entry.characterId !== characterId,
      );
      const removed = file.characters.length !== count;
      if (file.defaultCharacterId === characterId)
        delete file.defaultCharacterId;
      if (removed) await this.persist(file);
      return removed;
    });
  }

  private upsert(file: CredentialFile, credential: CharacterCredential): void {
    file.characters = file.characters.filter(
      (entry) => entry.characterId !== credential.characterId,
    );
    file.characters.push(credential);
  }

  private async update(action: (file: CredentialFile) => void): Promise<void> {
    await this.lock(".lock", async () => {
      const file = await this.read();
      action(file);
      await this.persist(file);
    });
  }

  private async persist(file: CredentialFile): Promise<void> {
    const parsed = fileSchema.safeParse(file);
    if (!parsed.success) throw new Error("Invalid EVE credential update.");
    const temporaryPath = `${this.path}.${randomUUID()}.tmp`;
    try {
      await writeFile(
        temporaryPath,
        `${JSON.stringify(parsed.data, null, 2)}\n`,
        { encoding: "utf8", mode: 0o600, flag: "wx" },
      );
      await chmod(temporaryPath, 0o600);
      await rename(temporaryPath, this.path);
    } finally {
      await rm(temporaryPath, { force: true });
    }
  }

  private async lock<T>(suffix: string, action: () => Promise<T>): Promise<T> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const lockPath = `${this.path}${suffix}`;
    const deadline = Date.now() + 30_000;
    for (;;) {
      try {
        await mkdir(lockPath, { mode: 0o700 });
        break;
      } catch (error) {
        if (!hasCode(error, "EEXIST")) throw error;
        if (Date.now() >= deadline)
          // The filesystem error can expose a credential path; report only safe guidance.
          // eslint-disable-next-line preserve-caught-error
          throw new Error(
            "EVE credential store is busy; retry after the other authentication process finishes.",
          );
        await delay(25);
      }
    }
    try {
      return await action();
    } finally {
      await rmdir(lockPath);
    }
  }
}
