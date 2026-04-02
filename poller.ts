/**
 * Polling loop — fetches channels and messages from Discord and populates the cache.
 *
 * - On startup: fetch channel list, then messages for each text channel
 * - Every POLL_INTERVAL_MS: refresh channels and messages
 * - Timeout: 10s per channel fetch, 30s total for initial poll
 * - Errors are logged and continued — never crashes the process
 */

import type { Config, LogLevel } from "./config";
import type { DiscordClient, DiscordChannel } from "./discord";
import type { Cache } from "./cache";

// Discord channel type 0 = GUILD_TEXT
const GUILD_TEXT_CHANNEL = 0;

const PER_CHANNEL_TIMEOUT_MS = 10_000;
const INITIAL_POLL_TIMEOUT_MS = 30_000;

export interface Logger {
  debug(msg: string): void;
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

function createLogger(level: LogLevel): Logger {
  const levels: Record<LogLevel, number> = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3,
  };
  const threshold = levels[level];

  function log(lvl: LogLevel, msg: string): void {
    if (levels[lvl] >= threshold) {
      const ts = new Date().toISOString();
      console.log(`[${ts}] [${lvl.toUpperCase()}] ${msg}`);
    }
  }

  return {
    debug: (msg: string) => log("debug", msg),
    info: (msg: string) => log("info", msg),
    warn: (msg: string) => log("warn", msg),
    error: (msg: string) => log("error", msg),
  };
}

/**
 * Wrap a promise with a timeout. Resolves to the promise result, or rejects
 * with a timeout error after `ms` milliseconds.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timeout after ${ms}ms: ${label}`));
    }, ms);

    promise
      .then((val) => {
        clearTimeout(timer);
        resolve(val);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

/**
 * Run a single poll cycle: fetch channels, then fetch messages for each text channel.
 * Returns the number of text channels polled.
 */
async function pollCycle(
  client: DiscordClient,
  cache: Cache,
  guildId: string,
  logger: Logger,
  perChannelTimeout: number,
): Promise<number> {
  // Fetch channels
  const channels = await withTimeout(
    client.fetchChannels(guildId),
    perChannelTimeout,
    `fetchChannels(${guildId})`,
  );
  cache.setChannels(guildId, channels);

  // Filter to text channels only
  const textChannels = channels.filter(
    (ch: DiscordChannel) => ch.type === GUILD_TEXT_CHANNEL,
  );
  logger.debug(`Found ${textChannels.length} text channels in guild ${guildId}`);

  // Fetch messages for each text channel
  for (const channel of textChannels) {
    try {
      const messages = await withTimeout(
        client.fetchMessages(channel.id),
        perChannelTimeout,
        `fetchMessages(${channel.id})`,
      );
      cache.setMessages(channel.id, messages);
      logger.debug(
        `Cached ${messages.length} messages for #${channel.name ?? channel.id}`,
      );
    } catch (err) {
      logger.error(
        `Failed to fetch messages for channel ${channel.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
      // Continue to next channel — don't crash
    }
  }

  // Run eviction after populating
  cache.evict();

  return textChannels.length;
}

/**
 * Run the initial poll with a total timeout of INITIAL_POLL_TIMEOUT_MS.
 * If the timeout fires, the server starts with an empty (or partial) cache.
 */
export async function initialPoll(
  client: DiscordClient,
  cache: Cache,
  guildId: string,
  logger: Logger,
): Promise<number> {
  try {
    const channelCount = await withTimeout(
      pollCycle(client, cache, guildId, logger, PER_CHANNEL_TIMEOUT_MS),
      INITIAL_POLL_TIMEOUT_MS,
      "initial poll",
    );
    logger.info(`Initial poll complete: ${channelCount} text channels cached`);
    return channelCount;
  } catch (err) {
    logger.warn(
      `Initial poll timed out or failed: ${err instanceof Error ? err.message : String(err)}. Starting with empty/partial cache.`,
    );
    return 0;
  }
}

/**
 * Start the continuous polling loop. Runs indefinitely.
 * Returns a cleanup function that stops the loop.
 */
export function startPollingLoop(
  client: DiscordClient,
  cache: Cache,
  config: Config,
): { stop: () => void; logger: Logger } {
  const logger = createLogger(config.logLevel);
  let timer: ReturnType<typeof setInterval> | null = null;

  timer = setInterval(async () => {
    try {
      await pollCycle(
        client,
        cache,
        config.discordGuildId,
        logger,
        PER_CHANNEL_TIMEOUT_MS,
      );
      logger.debug("Poll cycle complete");
    } catch (err) {
      logger.error(
        `Poll cycle failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }, config.pollIntervalMs);

  return {
    stop: () => {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    },
    logger,
  };
}

export { createLogger, withTimeout };
