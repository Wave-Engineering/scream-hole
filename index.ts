import { loadConfig } from "./config";
import { createDiscordClient } from "./discord";
import { createCache } from "./cache";
import type { Cache } from "./cache";
import { initialPoll, startPollingLoop, createLogger } from "./poller";

const VERSION = "0.2.0";
const startTime = Date.now();

/**
 * Create the request handler with access to cache and config.
 */
function createHandler(cache: Cache, guildId: string, cacheTtlMs?: number) {
  const ttl = cacheTtlMs ?? Infinity;
  return function handleRequest(req: Request): Response {
    const url = new URL(req.url);

    // Health endpoint — includes cache stats
    if (req.method === "GET" && url.pathname === "/health") {
      const stats = cache.getStats();
      return Response.json({
        status: "ok",
        uptime: Math.floor((Date.now() - startTime) / 1000),
        version: VERSION,
        cache: {
          channelsCached: stats.channelsCached,
          totalMessages: stats.totalMessages,
          hits: stats.hits,
          misses: stats.misses,
        },
      });
    }

    // GET /api/v10/guilds/{guildId}/channels
    const channelsMatch = url.pathname.match(
      /^\/api\/v10\/guilds\/([^/]+)\/channels$/,
    );
    if (req.method === "GET" && channelsMatch) {
      const reqGuildId = channelsMatch[1];
      const result = cache.getChannels(reqGuildId);
      if (!result) {
        return Response.json(
          { error: `No cached data for guild ${reqGuildId}` },
          { status: 404 },
        );
      }
      const channelFresh = Date.now() - result.cachedAt <= ttl;
      return new Response(JSON.stringify(result.data), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "X-Cache": channelFresh ? "HIT" : "STALE",
          "X-Cached-At": new Date(result.cachedAt).toISOString(),
        },
      });
    }

    // GET /api/v10/channels/{channelId}/messages
    const messagesMatch = url.pathname.match(
      /^\/api\/v10\/channels\/([^/]+)\/messages$/,
    );
    if (req.method === "GET" && messagesMatch) {
      const channelId = messagesMatch[1];

      // `after` is REQUIRED and must be a valid snowflake (numeric string)
      const after = url.searchParams.get("after");
      if (!after || !/^\d+$/.test(after)) {
        return Response.json(
          { error: "`after` query parameter is required and must be a valid snowflake ID (numeric string)" },
          { status: 400 },
        );
      }

      const limitParam = url.searchParams.get("limit");
      let limit: number | undefined;
      if (limitParam !== null) {
        const parsed = Number(limitParam);
        if (!Number.isInteger(parsed) || parsed <= 0) {
          return Response.json(
            { error: "`limit` must be a positive integer" },
            { status: 400 },
          );
        }
        limit = parsed;
      }

      const result = cache.getMessages(channelId, after, limit);
      if (!result) {
        return Response.json(
          { error: `No cached data for channel ${channelId}` },
          { status: 404 },
        );
      }

      const msgFresh = Date.now() - result.cachedAt <= ttl;
      return new Response(JSON.stringify(result.data), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "X-Cache": msgFresh ? "HIT" : "STALE",
          "X-Cached-At": new Date(result.cachedAt).toISOString(),
        },
      });
    }

    return Response.json({ error: "not found" }, { status: 404 });
  };
}

// Only start the server when run directly (not during tests importing this module)
if (import.meta.main) {
  const config = loadConfig();
  const client = createDiscordClient(config.discordBotToken);
  const cache = createCache(config.cacheTtlMs, config.cacheWindowMs);
  const logger = createLogger(config.logLevel);

  logger.info(`scream-hole v${VERSION} starting...`);

  // Initial poll with timeout — if it fails, start with empty cache
  const channelCount = await initialPoll(
    client,
    cache,
    config.discordGuildId,
    logger,
  );

  const handler = createHandler(cache, config.discordGuildId, config.cacheTtlMs);

  const server = Bun.serve({
    port: config.port,
    fetch: handler,
  });

  // Start the continuous polling loop
  const poller = startPollingLoop(client, cache, config);

  const intervalSec = (config.pollIntervalMs / 1000).toFixed(1);
  logger.info(
    `scream-hole listening on :${server.port}, polling ${channelCount} channels every ${intervalSec}s`,
  );
}

export { createHandler, VERSION };
