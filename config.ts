import { readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Config {
  /** Discord bot token — from env or ~/secrets/discord-bot-token */
  discordBotToken: string;
  /** Discord guild (server) ID */
  discordGuildId: string;
  /** Polling interval in milliseconds */
  pollIntervalMs: number;
  /** HTTP server port */
  port: number;
  /** Log level */
  logLevel: LogLevel;
}

const VALID_LOG_LEVELS: ReadonlySet<string> = new Set([
  "debug",
  "info",
  "warn",
  "error",
]);

/**
 * Attempt to read the bot token from ~/secrets/discord-bot-token.
 * Returns undefined if the file doesn't exist or isn't readable.
 */
function readTokenFromFile(): string | undefined {
  try {
    const tokenPath = join(homedir(), "secrets", "discord-bot-token");
    return readFileSync(tokenPath, "utf-8").trim();
  } catch {
    return undefined;
  }
}

/**
 * Load configuration from environment variables with sensible defaults.
 * Throws if required variables are missing.
 */
export function loadConfig(
  env: Record<string, string | undefined> = process.env,
): Config {
  // Only fall back to file-based token when using process.env (production).
  // When a custom env dict is passed (tests), skip the file fallback.
  const discordBotToken =
    env.DISCORD_BOT_TOKEN || (env === process.env ? readTokenFromFile() : undefined);
  if (!discordBotToken) {
    throw new Error(
      "DISCORD_BOT_TOKEN is required (set env var or create ~/secrets/discord-bot-token)",
    );
  }

  const discordGuildId = env.DISCORD_GUILD_ID;
  if (!discordGuildId) {
    throw new Error("DISCORD_GUILD_ID is required");
  }

  const pollIntervalMs = Number(env.POLL_INTERVAL_MS) || 15000;
  const port = Number(env.PORT) || 3000;

  const rawLogLevel = (env.LOG_LEVEL ?? "info").toLowerCase();
  const logLevel: LogLevel = VALID_LOG_LEVELS.has(rawLogLevel)
    ? (rawLogLevel as LogLevel)
    : "info";

  return {
    discordBotToken,
    discordGuildId,
    pollIntervalMs,
    port,
    logLevel,
  };
}
