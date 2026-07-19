import { loadConfig } from "./config";
import { createDiscordClient } from "./discord";
import type { DiscordClient, DiscordMessage, SendMessageResponse } from "./discord";
import { createCache } from "./cache";
import type { Cache } from "./cache";
import { initialPoll, startPollingLoop, createLogger, createChannelHealth } from "./poller";
import { claim, release, status, DEFAULT_TTL, type LeaseKind } from "./mic";

const VERSION = "1.2.0";
const startTime = Date.now();

/**
 * Statuses that MUST have a null body per the Fetch spec — constructing a
 * `Response` with a non-null body and one of these throws. Discord can return
 * 204 No Content from a webhook-execute (#23), so the shared write builder
 * must emit a null body for these (#22).
 */
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

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
  const headers = new Headers();
  for (const name of RATE_LIMIT_HEADERS) {
    const value = result.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  // Null-body statuses (e.g. a 204 from webhook-execute) must not carry a body,
  // else the Response constructor throws (#22). Still forward rate-limit headers.
  if (NULL_BODY_STATUSES.has(result.status)) {
    return new Response(null, { status: result.status, headers });
  }
  headers.set("Content-Type", "application/json");
  return new Response(JSON.stringify(result.body), {
    status: result.status,
    headers,
  });
}

/**
 * Build an error Response that ORIGINATED here rather than at Discord.
 *
 * Every proxy-originated error carries `proxy: "scream-hole"`; a response
 * forwarded from Discord (see {@link writeResponse}) never does. That gives
 * consumers a single, positive test for "who answered me" — check for the
 * presence of `proxy`, never for the absence of Discord's `code`.
 *
 * Why this is a helper and not a convention: the #25 outage happened because a
 * proxy-originated 404 was byte-comparable to Discord's own, and consumers read
 * it as "the resource was deleted". Any error we construct is capable of that
 * confusion, so stamping it must be structural — a future route that forgets to
 * opt in is exactly how this class comes back.
 */
function proxyError(error: string, status: number): Response {
  return Response.json({ error, proxy: "scream-hole" }, { status });
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

  /**
   * Outermost guard: any throw that escapes the router would otherwise become
   * Bun.serve's own bare 500 — no `proxy` marker, and so indistinguishable from
   * Discord's `{"message":"500: Internal Server Error","code":0}`.
   *
   * The status here is 500 and the wording is deliberately NEUTRAL: at this
   * depth we know only that WE failed, never why. An earlier version of this
   * guard returned `502 "upstream Discord request failed"` for everything it
   * caught, which was a lie on any route that never contacted Discord — a cache
   * throw or a malformed body read got reported as an upstream fault. Since the
   * README tells consumers to treat that as transient, a deterministic internal
   * bug would have been retried forever instead of surfacing.
   *
   * That is worth spelling out because it is the #25 defect reproduced inside
   * its own fix: mislabeling one party's failure as another's. Upstream failures
   * are attributed narrowly, at the call that actually contacts Discord — see
   * {@link forwardUpstream}. This guard only catches what that one misses.
   */
  return async function handleRequest(req: Request): Promise<Response> {
    // Built BEFORE the try, and nothing in the catch below may throw. A
    // last-resort net that can itself tear is not a net: if `route` failed
    // *because* `new URL(req.url)` threw, doing the same parse inside the catch
    // would re-throw and escape as the unmarked bare 500 this guard exists to
    // prevent. Same reason `String(err)` is avoided — it throws on a
    // null-prototype value.
    let label: string;
    try {
      label = `${req.method} ${new URL(req.url).pathname}`;
    } catch {
      // A literal, NOT `req.method` — that would re-run an expression from the
      // try body that may be exactly what just failed, inside the block whose
      // whole purpose is that it cannot fail. Unreachable for a spec-conformant
      // Request, but the pattern is the one this file forbids elsewhere.
      label = "<unknown request>";
    }

    try {
      return await route(req);
    } catch (err) {
      // Logging is best-effort and is isolated so it can NEVER prevent the
      // response. `err` is arbitrary — reading `.stack` or `.message` runs
      // attacker/library-controlled getters, and interpolating the result runs a
      // `toString`. Any of those can throw, and a throw here escapes as the
      // unmarked bare 500 this guard exists to prevent.
      //
      // This is not theoretical: an earlier version did the read and the
      // interpolation directly in this block, and an Error with an own throwing
      // `stack` getter tore straight through it. Verified by test — see
      // "the last-resort guard cannot be torn" in tests/index.test.ts.
      try {
        const detail =
          err instanceof Error ? (err.stack ?? err.message) : "non-Error thrown value";
        console.error(`[proxy] internal error handling ${label}: ${String(detail)}`);
      } catch {
        // Deliberately empty — a failure to DESCRIBE the failure must not
        // escalate into a failure to ANSWER. Nothing is retried here on purpose:
        // a fallback log inside this catch could throw for the same reason the
        // first one did, which is the same mistake one level down.
      }
      return proxyError("proxy failed to handle this request", 500);
    }
  };

  /**
   * Run the one call that actually contacts Discord, converting a transport-level
   * rejection (DNS failure, connection reset, TLS error) into an attributable 502.
   *
   * Scoped deliberately tight — around the upstream call and nothing else. 502
   * asserts "we tried to reach the origin and could not", and that claim is only
   * true here. Widening this to cover surrounding logic would make the proxy
   * blame Discord for its own faults, which is the mislabeling this whole issue
   * is about. Anything outside this call is an internal fault and gets the
   * neutral 500 from the outer guard instead.
   */
  async function forwardUpstream(
    fn: () => Promise<SendMessageResponse>,
    onResult?: (result: SendMessageResponse) => void,
  ): Promise<Response> {
    let result: SendMessageResponse;
    try {
      result = await fn();
    } catch (err) {
      // Isolated for the same reason as the outer guard, and with a sharper
      // consequence: a throw from this logging does not produce a bare 500 (the
      // outer guard catches it) but it DOES lose the 502, silently downgrading
      // "Discord was unreachable" to "we broke". That is the attribution this
      // function exists to provide, discarded while describing the failure.
      try {
        const detail =
          err instanceof Error ? (err.message ?? "") : "non-Error thrown value";
        console.error(`[proxy] upstream Discord request failed: ${String(detail)}`);
      } catch {
        // Empty on purpose — see the outer guard. Describing a failure must
        // never cost us the ability to attribute it.
      }
      return proxyError("upstream Discord request failed", 502);
    }
    // Outside the try on purpose: a throw from here is OUR bug, not Discord's,
    // and must not be reported as an upstream failure.
    onResult?.(result);
    return writeResponse(result);
  }

  async function route(req: Request): Promise<Response> {
    const url = new URL(req.url);

    // Forward a resource-creation POST to Discord verbatim (#18). Shared by the
    // create-channel and create-thread routes: 503 without a client, otherwise
    // return Discord's status + body unchanged. No cache injection — the poller
    // discovers the new channel/thread on its next cycle (eventual consistency).
    async function forwardCreate(
      fn: (body: BodyInit, contentType: string) => Promise<SendMessageResponse>,
    ): Promise<Response> {
      if (!client) {
        return proxyError("Write pass-through is not configured (no Discord client)", 503);
      }
      const contentType = req.headers.get("Content-Type") ?? "application/json";
      const rawBody = await req.arrayBuffer();
      return forwardUpstream(() => fn(rawBody, contentType));
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
        if (!channel) return proxyError("channel query param required", 400);
        return Response.json({ kind, channel, lease: status(kind, channel) });
      }
      if ((action === "claim" || action === "release") && req.method === "POST") {
        const body = (await req.json().catch(() => ({}))) as {
          channel?: string;
          holder?: string;
          ttl_ms?: number;
        };
        if (!body.channel || !body.holder) {
          return proxyError("channel and holder are required", 400);
        }
        if (action === "claim") {
          const ttl =
            typeof body.ttl_ms === "number" && body.ttl_ms > 0 ? body.ttl_ms : DEFAULT_TTL[kind];
          return Response.json({ kind, channel: body.channel, ...claim(kind, body.channel, body.holder, ttl) });
        }
        return Response.json({ kind, channel: body.channel, ...release(kind, body.channel, body.holder) });
      }
      return proxyError("method not allowed", 405);
    }

    // GET /api/v10/guilds/{guildId}/channels
    const channelsMatch = url.pathname.match(
      /^\/api\/v10\/guilds\/([^/]+)\/channels$/,
    );
    if (req.method === "GET" && channelsMatch) {
      const reqGuildId = channelsMatch[1];
      const result = cache.getChannels(reqGuildId);
      if (!result) {
        return proxyError(`No cached data for guild ${reqGuildId}`, 404);
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
        return proxyError(
            "`after` query parameter is required and must be a valid snowflake ID (numeric string)",
            400,
          );
      }

      const limitParam = url.searchParams.get("limit");
      let limit: number | undefined;
      if (limitParam !== null) {
        const parsed = Number(limitParam);
        if (!Number.isInteger(parsed) || parsed <= 0) {
          return proxyError("`limit` must be a positive integer", 400);
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
        return proxyError("Write pass-through is not configured (no Discord client)", 503);
      }

      const channelId = messagesMatch[1];
      const contentType = req.headers.get("Content-Type") ?? "application/json";

      // Read the raw body to forward transparently (supports JSON and multipart)
      const rawBody = await req.arrayBuffer();

      // Returns Discord's response verbatim (status + body + rate-limit headers);
      // a transport-level rejection becomes an attributable 502 rather than a
      // 500 blamed on us or a bare 500 blamed on nobody.
      return forwardUpstream(
        () => client.sendMessage(channelId, rawBody, contentType),
        (result) => {
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
        },
      );
    }

    // GET /api/v10/channels/{channelId}/messages/{messageId} — single-message fetch (#25)
    //
    // Needs its own route because the LIST regex above is `$`-anchored: this form
    // has an extra path segment, so before #25 it fell through to the catch-all and
    // returned the proxy's own 404. Consumers read that 404 as "the message was
    // deleted" (watcher #41 `fetchMessageById` maps any 404 to `gone`, and `gone` is
    // dropped rather than retried), so every forwarded message was silently lost.
    //
    // Live, non-cached forward — and that is load-bearing, not incidental. Serving
    // this from cache would return a stale hit for a message deleted upstream,
    // inverting the exact deleted-vs-transient discrimination the caller is making:
    // a silent false positive, strictly worse than the 404 it replaces. The cost is
    // one live Discord call per lookup, on the low-volume forward path only.
    const messageByIdMatch = url.pathname.match(
      /^\/api\/v10\/channels\/([^/]+)\/messages\/([^/]+)$/,
    );
    if (req.method === "GET" && messageByIdMatch) {
      if (!client) {
        return proxyError("Single-message fetch is not configured (no Discord client)", 503);
      }
      const [, channelId, messageId] = messageByIdMatch;
      // Snowflake-validate before forwarding. The reason is the same failure this
      // whole route exists to fix: an unvalidated id would be forwarded upstream
      // and come back as Discord's own 404, which callers read as "deleted" and
      // drop silently — so a typo'd id would vanish a message exactly the way an
      // unrouted path used to. A 400 is read as an error and retried/surfaced.
      // Secondarily, this route is uncached, so every request is a live Discord
      // call; rejecting garbage here keeps malformed ids off our rate budget.
      //
      // Not a path-traversal guard: `..` and `%2e%2e` are already collapsed by
      // `new URL(req.url)` above, so they can never reach this regex as a segment.
      // Matches the snowflake checks the LIST route applies to `after` (:179) and
      // the cache-injection path applies to `msg.id` (:250).
      if (!/^\d+$/.test(messageId!)) {
        return proxyError("`messageId` must be a valid snowflake ID (numeric string)", 400);
      }
      return forwardUpstream(() => client.fetchMessage(channelId!, messageId!));
    }

    // POST /api/v10/channels/{channelId}/threads — create-thread pass-through (#18, mcp#47)
    // Covers standalone thread creation only. The message-anchored form
    // POST /channels/{id}/messages/{id}/threads is NOT matched here — no
    // consumer creates threads from a message today; add a route if that
    // changes (otherwise it falls through to the 501 catch-all).
    const threadsMatch = url.pathname.match(
      /^\/api\/v10\/channels\/([^/]+)\/threads$/,
    );
    if (req.method === "POST" && threadsMatch) {
      const channelId = threadsMatch[1];
      return forwardCreate((body, ct) => client!.createThread(channelId, body, ct));
    }

    // /api/v10/channels/{channelId}/webhooks — webhook list (GET) + create (POST) (#23)
    const webhooksMatch = url.pathname.match(
      /^\/api\/v10\/channels\/([^/]+)\/webhooks$/,
    );
    if (req.method === "GET" && webhooksMatch) {
      if (!client) {
        return proxyError("Webhook pass-through is not configured (no Discord client)", 503);
      }
      // Live, non-cached forward: webhook tokens must not be cached/staled, and
      // the body (each webhook's `token`) passes through verbatim so consumers
      // reuse an existing webhook instead of exhausting Discord's per-channel cap.
      return forwardUpstream(() => client.listWebhooks(webhooksMatch[1]!));
    }
    if (req.method === "POST" && webhooksMatch) {
      const channelId = webhooksMatch[1];
      return forwardCreate((body, ct) => client!.createWebhook(channelId, body, ct));
    }

    // POST /api/v10/webhooks/{webhookId}/{token} — webhook execute pass-through (#23)
    // Top-level route (not under /channels). The verbatim query string (e.g.
    // `?wait=true`) is preserved — disc-server relies on it to get the message back.
    const webhookExecMatch = url.pathname.match(
      /^\/api\/v10\/webhooks\/([^/]+)\/([^/]+)$/,
    );
    if (req.method === "POST" && webhookExecMatch) {
      const [, webhookId, token] = webhookExecMatch;
      return forwardCreate((body, ct) =>
        client!.executeWebhook(webhookId, token, url.search, body, ct),
      );
    }

    // Unrouted path (#25). Deliberately NOT 404.
    //
    // This proxy impersonates Discord's API surface, so a 404 from here is
    // indistinguishable from Discord's own `{"message":"Unknown Message",
    // "code":10008}` — and consumers read that as "the resource was deleted".
    // That misread is not hypothetical: it silently dropped every forwarded
    // message for days, because a missing route and a deleted message gave the
    // caller byte-comparable answers. A 404 asserts something about the origin
    // resource that we never asked the origin. 501 says the true thing: this
    // proxy does not serve this path.
    //
    // `proxy` identifies us POSITIVELY. Consumers should discriminate on its
    // presence, not on the absence of Discord's `code` field — an absence-based
    // check flips silently the day either body grows a field, and stays wrong
    // without failing any test.
    return proxyError("no route for this path", 501);
  }
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
