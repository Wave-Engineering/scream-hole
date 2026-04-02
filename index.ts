import { loadConfig } from "./config";
import { createDiscordClient } from "./discord";
import type { DiscordClient, DiscordMessage } from "./discord";
import { createCache } from "./cache";
import type { Cache } from "./cache";
import { initialPoll, startPollingLoop, createLogger } from "./poller";

const VERSION = "0.2.0";
const startTime = Date.now();

/**
 * Create the request handler with access to cache and config.
 * When a DiscordClient is provided, write pass-through (POST) routes are enabled.
 */
function createHandler(
  cache: Cache,
  guildId: string,
  cacheTtlMs?: number,
  client?: DiscordClient,
) {
  const ttl = cacheTtlMs ?? Infinity;
  return async function handleRequest(req: Request): Promise<Response> {
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

    // Match /api/v10/channels/{channelId}/messages for both GET and POST
    const messagesMatch = url.pathname.match(
      /^\/api\/v10\/channels\/([^/]+)\/messages$/,
    );

    // GET /api/v10/channels/{channelId}/messages
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

    // POST /api/v10/channels/{channelId}/messages — write pass-through
    if (req.method === "POST" && messagesMatch) {
      if (!client) {
        return Response.json(
          { error: "Write pass-through is not configured (no Discord client)" },
          { status: 503 },
        );
      }

      const channelId = messagesMatch[1];
      const contentType = req.headers.get("Content-Type") ?? "application/json";

      // Read the raw body to forward transparently (supports JSON and multipart)
      const rawBody = await req.arrayBuffer();

      const result = await client.sendMessage(
        channelId,
        rawBody,
        contentType,
      );

      // On success, inject the returned message into the cache
      if (result.ok) {
        const msg = result.body as DiscordMessage;
        if (msg && typeof msg.id === "string" && /^\d+$/.test(msg.id)) {
          try {
            cache.setMessages(channelId, [msg]);
          } catch {
            // Cache write failure should not break the response
          }
        }
      }

      // Return Discord's response verbatim (status code + body)
      return Response.json(result.body, { status: result.status });
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

  const handler = createHandler(cache, config.discordGuildId, config.cacheTtlMs, client);

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
