import { loadConfig } from "./config";
import { createDiscordClient } from "./discord";
import type { DiscordClient, DiscordMessage, SendMessageResponse } from "./discord";
import { createCache } from "./cache";
import type { Cache } from "./cache";
import { initialPoll, startPollingLoop, createLogger, createChannelHealth } from "./poller";
import { claim, release, status, DEFAULT_TTL, type LeaseKind } from "./mic";

const VERSION = "1.1.0";
const startTime = Date.now();

/**
 * Discord rate-limit response headers, forwarded verbatim on write pass-throughs
 * so callers can honor Discord's exact backoff (esp. on a propagated 429) instead
 * of guessing. Allowlist — NOT a blind copy — so edge headers like Set-Cookie /
 * CF-* / transfer-encoding never leak through the proxy.
 */
const RATE_LIMIT_HEADERS = [
  "retry-after",
  "x-ratelimit-limit",
  "x-ratelimit-remaining",
  "x-ratelimit-reset",
  "x-ratelimit-reset-after",
  "x-ratelimit-bucket",
  "x-ratelimit-global",
  "x-ratelimit-scope",
];

/**
 * Build the proxy's Response for a forwarded write (message send / create
 * channel / create thread): Discord's status + body verbatim, plus any
 * allowlisted rate-limit headers Discord returned.
 */
function writeResponse(result: SendMessageResponse): Response {
  const headers = new Headers({ "Content-Type": "application/json" });
  for (const name of RATE_LIMIT_HEADERS) {
    const value = result.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  return new Response(JSON.stringify(result.body), {
    status: result.status,
    headers,
  });
}

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

    // Forward a resource-creation POST to Discord verbatim (#18). Shared by the
    // create-channel and create-thread routes: 503 without a client, otherwise
    // return Discord's status + body unchanged. No cache injection — the poller
    // discovers the new channel/thread on its next cycle (eventual consistency).
    async function forwardCreate(
      fn: (body: BodyInit, contentType: string) => Promise<SendMessageResponse>,
    ): Promise<Response> {
      if (!client) {
        return Response.json(
          { error: "Write pass-through is not configured (no Discord client)" },
          { status: 503 },
        );
      }
      const contentType = req.headers.get("Content-Type") ?? "application/json";
      const rawBody = await req.arrayBuffer();
      const result = await fn(rawBody, contentType);
      return writeResponse(result);
    }

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

    // Advisory coordination leases (#14): /lease/{mic|send}/{claim|release|status}
    const leaseMatch = url.pathname.match(/^\/lease\/(mic|send)\/(claim|release|status)$/);
    if (leaseMatch) {
      const kind = leaseMatch[1] as LeaseKind;
      const action = leaseMatch[2];
      if (action === "status" && req.method === "GET") {
        const channel = url.searchParams.get("channel");
        if (!channel) return Response.json({ error: "channel query param required" }, { status: 400 });
        return Response.json({ kind, channel, lease: status(kind, channel) });
      }
      if ((action === "claim" || action === "release") && req.method === "POST") {
        const body = (await req.json().catch(() => ({}))) as {
          channel?: string;
          holder?: string;
          ttl_ms?: number;
        };
        if (!body.channel || !body.holder) {
          return Response.json({ error: "channel and holder are required" }, { status: 400 });
        }
        if (action === "claim") {
          const ttl =
            typeof body.ttl_ms === "number" && body.ttl_ms > 0 ? body.ttl_ms : DEFAULT_TTL[kind];
          return Response.json({ kind, channel: body.channel, ...claim(kind, body.channel, body.holder, ttl) });
        }
        return Response.json({ kind, channel: body.channel, ...release(kind, body.channel, body.holder) });
      }
      return Response.json({ error: "method not allowed" }, { status: 405 });
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

    // POST /api/v10/guilds/{guildId}/channels — create-channel pass-through (#18)
    if (req.method === "POST" && channelsMatch) {
      const reqGuildId = channelsMatch[1];
      return forwardCreate((body, ct) => client!.createChannel(reqGuildId, body, ct));
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
        // Fail open (#16): an uncached channel — brand-new, pre-first-poll, or
        // a race — is indistinguishable to clients from a quiet one. Returning
        // 404 makes clients re-poll Discord directly and storm its rate limit.
        // Return 200 [] ("nothing new") instead; clients dedup by message id
        // and handle empty arrays cleanly.
        return new Response("[]", {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "X-Cache": "MISS",
          },
        });
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

      // Return Discord's response verbatim (status + body + rate-limit headers)
      return writeResponse(result);
    }

    // POST /api/v10/channels/{channelId}/threads — create-thread pass-through (#18, mcp#47)
    // Covers standalone thread creation only. The message-anchored form
    // POST /channels/{id}/messages/{id}/threads is NOT matched here — no
    // consumer creates threads from a message today; add a route if that
    // changes (otherwise it would 404 through the proxy).
    const threadsMatch = url.pathname.match(
      /^\/api\/v10\/channels\/([^/]+)\/threads$/,
    );
    if (req.method === "POST" && threadsMatch) {
      const channelId = threadsMatch[1];
      return forwardCreate((body, ct) => client!.createThread(channelId, body, ct));
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
  const health = createChannelHealth(config.pollIntervalMs);

  logger.info(`scream-hole v${VERSION} starting...`);

  // Initial poll with timeout — if it fails, start with empty cache
  const channelCount = await initialPoll(
    client,
    cache,
    config.discordGuildId,
    logger,
    health,
  );

  const handler = createHandler(cache, config.discordGuildId, config.cacheTtlMs, client);

  const server = Bun.serve({
    port: config.port,
    fetch: handler,
  });

  // Start the continuous polling loop
  const poller = startPollingLoop(client, cache, config, health);

  const intervalSec = (config.pollIntervalMs / 1000).toFixed(1);
  logger.info(
    `scream-hole listening on :${server.port}, polling ${channelCount} channels every ${intervalSec}s`,
  );
}

export { createHandler, VERSION };
