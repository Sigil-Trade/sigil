/**
 * Agent config persistence — reads / writes ~/.sigil/agents/<vault>.json.
 *
 * Each vault the agent operates on gets its own keypair + metadata file.
 * Lives in the user's home dir (NOT in the project repo) so an agent
 * keypair is bound to the machine, not to a checkout.
 *
 * File shape:
 *   {
 *     vaultAddress: string,
 *     ownerAddress: string,
 *     network: "devnet" | "mainnet",
 *     agent: {
 *       address: string,
 *       secretKey: number[]    // 64-byte signing key as Solana CLI format
 *     },
 *     createdAt: string         // ISO8601
 *   }
 *
 * Permissions: 0600 on creation (owner read/write only). The secret key
 * never leaves this file unencrypted; future versions will optionally
 * encrypt with a passphrase (xchacha20-poly1305) and prompt on load.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface AgentConfig {
  readonly vaultAddress: string;
  readonly ownerAddress: string;
  readonly network: "devnet" | "mainnet";
  readonly agent: {
    readonly address: string;
    readonly secretKey: readonly number[];
  };
  readonly createdAt: string;
}

const SIGIL_DIR = join(homedir(), ".sigil");
const AGENTS_DIR = join(SIGIL_DIR, "agents");

export function configPathFor(vaultAddress: string): string {
  return join(AGENTS_DIR, `${vaultAddress}.json`);
}

export function loadConfig(vaultAddress: string): AgentConfig | null {
  const path = configPathFor(vaultAddress);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as AgentConfig;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Find the first available agent config. Used by the MCP server when no
 * specific vault is requested — agents typically operate one vault at a
 * time, so picking the first is a reasonable default. If none exists,
 * returns null and the server prompts the user to run `setup`.
 */
export function loadDefaultConfig(): AgentConfig | null {
  if (!existsSync(AGENTS_DIR)) return null;
  const files = readdirSync(AGENTS_DIR).filter((f) => f.endsWith(".json"));
  const first = files[0];
  if (!first) return null;
  const vaultAddress = first.replace(/\.json$/, "");
  return loadConfig(vaultAddress);
}

export function saveConfig(config: AgentConfig): void {
  const path = configPathFor(config.vaultAddress);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(config, null, 2), { mode: 0o600 });
}

export function listConfigs(): AgentConfig[] {
  if (!existsSync(AGENTS_DIR)) return [];
  return readdirSync(AGENTS_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => loadConfig(f.replace(/\.json$/, "")))
    .filter((c): c is AgentConfig => c !== null);
}
