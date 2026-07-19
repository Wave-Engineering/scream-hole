import { describe, expect, test } from "bun:test";
import { createHandler, VERSION } from "../index";
import { createCache } from "../cache";
import type {
  DiscordChannel,
  DiscordClient,
  DiscordMessage,
  SendMessageResponse,
} from "../discord";

/**
 * Helper: create a Discord snowflake ID from a timestamp.
 * Discord epoch is 2015-01-01T00:00:00.000Z (1420070400000).
 */
function timestampToSnowflake(timestampMs: number): string {
  const discordEpoch = 1420070400000n;
  const ts = BigInt(timestampMs) - discordEpoch;
  return String(ts << 22n);
}

function makeMessage(
  id: string,
  channelId: string,
  content: string,
): DiscordMessage {
  return {
    id,
    channel_id: channelId,
    content,
    timestamp: new Date().toISOString(),
    author: { id: "user-1", username: "testuser" },
  };
}

function makeChannel(id: string, name: string): DiscordChannel {
  return { id, type: 0, name, guild_id: "guild-1" };
}

// Use long TTL and window so tests don't expire during execution
const TEST_TTL = 60_000;
const TEST_WINDOW = 4 * 60 * 60 * 1000; // 4 hours

/**
 * Helper: build a mock DiscordClient with a controllable response, capturing
 * the id/body/content-type of the last write (send, create-channel, or
 * create-thread).
 */
function mockClient(
  sendResponse: SendMessageResponse,
): DiscordClient & {
  captured: {
    channelId: string;
    messageId: string;
    body: string;
    contentType: string;
    search: string;
  };
} {
  const captured = { channelId: "", messageId: "", body: "", contentType: "", search: "" };
  const record = (id: string, body: BodyInit, contentType: string) => {
    captured.channelId = id;
    if (body instanceof ArrayBuffer) {
      captured.body = new TextDecoder().decode(body);
    } else if (typeof body === "string") {
      captured.body = body;
    }
    captured.contentType = contentType;
  };
  return {
    captured,
    async fetchChannels() {
      return [];
    },
    async fetchMessages() {
      return [];
    },
    async sendMessage(channelId, body, contentType) {
      record(channelId, body, contentType);
      return sendResponse;
    },
    async createChannel(guildId, body, contentType) {
      record(guildId, body, contentType);
      return sendResponse;
    },
    async createThread(channelId, body, contentType) {
      record(channelId, body, contentType);
      return sendResponse;
    },
    async fetchMessage(channelId, messageId) {
      captured.channelId = channelId;
      captured.messageId = messageId;
      return sendResponse;
    },
    async listWebhooks(channelId) {
      captured.channelId = channelId;
      return sendResponse;
    },
    async createWebhook(channelId, body, contentType) {
      record(channelId, body, contentType);
      return sendResponse;
    },
    async executeWebhook(webhookId, token, search, body, contentType) {
      record(webhookId, body, contentType);
      captured.search = search;
      return sendResponse;
    },
  };
}

// The two version fields must move together. Nothing enforced that: the /health
// test below compares the served value against the same constant that produced
// it, so it is tautological — it proves /health is WIRED to VERSION, which is
// useful, but it can never catch a missed or half-applied bump. That left the
// release convention (bdb607a) resting entirely on the author remembering both
// files, with no automated backstop.
//
// LIMIT, stated adjacent: this catches DRIFT BETWEEN the two files. It cannot
// catch both being bumped to the same wrong value, and it does not know the git
// tag exists — agreement with `v{VERSION}` is still verified by hand at tag time.
test("VERSION and package.json agree — a half-applied bump fails here", async () => {
  const pkg = (await Bun.file(
    new URL("../package.json", import.meta.url).pathname,
  ).json()) as { version: string };

  expect(VERSION).toBe(pkg.version);
});

describe("GET /health", () => {
  test("returns 200 with status ok, uptime, version, and cache stats", async () => {
    const cache = createCache(TEST_TTL, TEST_WINDOW);
    const handler = createHandler(cache, "guild-1");
    const req = new Request("http://localhost/health", { method: "GET" });
    const res = await handler(req);

    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(typeof body.uptime).toBe("number");
    expect(body.uptime).toBeGreaterThanOrEqual(0);
    expect(body.version).toBe(VERSION);
    // Cache stats present
    expect(body.cache).toBeDefined();
    expect(typeof body.cache.channelsCached).toBe("number");
    expect(typeof body.cache.totalMessages).toBe("number");
    expect(typeof body.cache.hits).toBe("number");
    expect(typeof body.cache.misses).toBe("number");
  });
});

describe("GET /api/v10/guilds/{guildId}/channels", () => {
  test("returns cached channel list with cache headers", async () => {
    const cache = createCache(TEST_TTL, TEST_WINDOW);
    const channels: DiscordChannel[] = [
      makeChannel("ch-1", "general"),
      makeChannel("ch-2", "random"),
    ];
    cache.setChannels("guild-1", channels);

    const handler = createHandler(cache, "guild-1");
    const req = new Request(
      "http://localhost/api/v10/guilds/guild-1/channels",
    );
    const res = await handler(req);

    expect(res.status).toBe(200);
    expect(res.headers.get("X-Cache")).toBe("HIT");
    expect(res.headers.get("X-Cached-At")).toBeTruthy();

    const body = await res.json();
    expect(body).toHaveLength(2);
    expect(body[0].id).toBe("ch-1");
    expect(body[1].id).toBe("ch-2");
  });

  test("returns 404 for unknown guild", async () => {
    const cache = createCache(TEST_TTL, TEST_WINDOW);
    const handler = createHandler(cache, "guild-1");
    const req = new Request(
      "http://localhost/api/v10/guilds/unknown-guild/channels",
    );
    const res = await handler(req);

    expect(res.status).toBe(404);
  });
});

describe("GET /api/v10/channels/{channelId}/messages", () => {
  test("returns 400 when `after` parameter is missing", async () => {
    const cache = createCache(TEST_TTL, TEST_WINDOW);
    const handler = createHandler(cache, "guild-1");

    // No `after` param
    const req = new Request(
      "http://localhost/api/v10/channels/ch-1/messages",
    );
    const res = await handler(req);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("after");
  });

  test("returns 400 when `after` is not a valid snowflake", async () => {
    const cache = createCache(TEST_TTL, TEST_WINDOW);
    const handler = createHandler(cache, "guild-1");

    const req = new Request(
      "http://localhost/api/v10/channels/ch-1/messages?after=abc",
    );
    const res = await handler(req);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("snowflake");
  });

  test("returns 400 when `limit` is not a positive integer", async () => {
    const cache = createCache(TEST_TTL, TEST_WINDOW);
    const now = Date.now();
    const afterId = timestampToSnowflake(now - 120_000);
    cache.setMessages("ch-1", [
      makeMessage(timestampToSnowflake(now - 60_000), "ch-1", "msg-1"),
    ]);

    const handler = createHandler(cache, "guild-1");
    const req = new Request(
      `http://localhost/api/v10/channels/ch-1/messages?after=${afterId}&limit=abc`,
    );
    const res = await handler(req);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("limit");
  });

  test("returns cached messages filtered by `after`", async () => {
    const cache = createCache(TEST_TTL, TEST_WINDOW);
    const now = Date.now();

    // Create messages with snowflake IDs representing different times
    const id1 = timestampToSnowflake(now - 60_000); // 1 minute ago
    const id2 = timestampToSnowflake(now - 30_000); // 30 seconds ago
    const id3 = timestampToSnowflake(now - 10_000); // 10 seconds ago

    cache.setMessages("ch-1", [
      makeMessage(id1, "ch-1", "old message"),
      makeMessage(id2, "ch-1", "middle message"),
      makeMessage(id3, "ch-1", "new message"),
    ]);

    const handler = createHandler(cache, "guild-1");

    // After id1 — should return id2 and id3
    const req = new Request(
      `http://localhost/api/v10/channels/ch-1/messages?after=${id1}`,
    );
    const res = await handler(req);

    expect(res.status).toBe(200);
    expect(res.headers.get("X-Cache")).toBe("HIT");
    expect(res.headers.get("X-Cached-At")).toBeTruthy();

    const body = (await res.json()) as DiscordMessage[];
    expect(body).toHaveLength(2);
    expect(body[0].content).toBe("middle message");
    expect(body[1].content).toBe("new message");
  });

  test("clamps `after` to window start when older than cache window", async () => {
    const cache = createCache(TEST_TTL, TEST_WINDOW);
    const now = Date.now();

    // Message within the window
    const recentId = timestampToSnowflake(now - 60_000);
    cache.setMessages("ch-1", [
      makeMessage(recentId, "ch-1", "recent"),
    ]);

    // `after` pointing to 5 hours ago — outside 4-hour window
    // Should clamp and return all messages within the window
    const oldId = timestampToSnowflake(now - 5 * 60 * 60 * 1000);

    const handler = createHandler(cache, "guild-1");
    const req = new Request(
      `http://localhost/api/v10/channels/ch-1/messages?after=${oldId}`,
    );
    const res = await handler(req);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { content: string }[];
    expect(body).toHaveLength(1);
    expect(body[0].content).toBe("recent");
  });

  // #16: an uncached channel must fail open to 200 [] (not 404), so clients
  // treat it as "nothing new" instead of re-polling Discord directly → 429.
  // The watcher/disc-server use three `after` shapes; all must return 200 [].
  test.each([
    ["after=0 (disc_read 'everything')", "0"],
    ["after=<4h-ago snowflake> (watcher baseline)", timestampToSnowflake(Date.now() - 4 * 60 * 60 * 1000)],
    ["after=<recent cursor> (watcher poll)", timestampToSnowflake(Date.now() - 30_000)],
  ])("returns 200 [] for uncached channel — fail open (%s)", async (_label, after) => {
    const cache = createCache(TEST_TTL, TEST_WINDOW);
    const handler = createHandler(cache, "guild-1");

    const req = new Request(
      `http://localhost/api/v10/channels/unknown-ch/messages?after=${after}`,
    );
    const res = await handler(req);

    expect(res.status).toBe(200);
    expect(res.headers.get("X-Cache")).toBe("MISS");
    const body = (await res.json()) as DiscordMessage[];
    expect(body).toEqual([]);
  });

  test("returns 200 [] for a discovered channel polled empty (no 404)", async () => {
    const cache = createCache(TEST_TTL, TEST_WINDOW);
    // Channel discovered + polled with zero messages, then an eviction pass.
    cache.setChannels("guild-1", [makeChannel("quiet-ch", "quiet")]);
    cache.setMessages("quiet-ch", []);
    cache.evict();

    const handler = createHandler(cache, "guild-1");
    const req = new Request(
      "http://localhost/api/v10/channels/quiet-ch/messages?after=0",
    );
    const res = await handler(req);

    expect(res.status).toBe(200);
    const body = (await res.json()) as DiscordMessage[];
    expect(body).toEqual([]);
  });

  test("`limit` parameter trims response to N newest messages", async () => {
    const cache = createCache(TEST_TTL, TEST_WINDOW);
    const now = Date.now();

    const id1 = timestampToSnowflake(now - 60_000);
    const id2 = timestampToSnowflake(now - 30_000);
    const id3 = timestampToSnowflake(now - 10_000);

    // A snowflake older than all messages, to use as `after`
    const afterId = timestampToSnowflake(now - 120_000);

    cache.setMessages("ch-1", [
      makeMessage(id1, "ch-1", "msg-1"),
      makeMessage(id2, "ch-1", "msg-2"),
      makeMessage(id3, "ch-1", "msg-3"),
    ]);

    const handler = createHandler(cache, "guild-1");
    const req = new Request(
      `http://localhost/api/v10/channels/ch-1/messages?after=${afterId}&limit=2`,
    );
    const res = await handler(req);

    expect(res.status).toBe(200);
    const body = (await res.json()) as DiscordMessage[];
    expect(body).toHaveLength(2);
    // Should return the 2 newest
    expect(body[0].content).toBe("msg-2");
    expect(body[1].content).toBe("msg-3");
  });
});

describe("POST /api/v10/channels/{channelId}/messages", () => {
  test("forwards POST body to Discord via client and returns response", async () => {
    const cache = createCache(TEST_TTL, TEST_WINDOW);
    const sentMsg: DiscordMessage = {
      id: timestampToSnowflake(Date.now()),
      channel_id: "ch-1",
      content: "hello from proxy",
      timestamp: new Date().toISOString(),
      author: { id: "u-1", username: "bot" },
    };

    const client = mockClient({
      ok: true,
      status: 200,
      headers: new Headers({ "Content-Type": "application/json" }),
      body: sentMsg,
    });

    const handler = createHandler(cache, "guild-1", TEST_TTL, client);
    const req = new Request(
      "http://localhost/api/v10/channels/ch-1/messages",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "hello from proxy" }),
      },
    );

    const res = await handler(req);

    expect(res.status).toBe(200);
    const body = (await res.json()) as DiscordMessage;
    expect(body.id).toBe(sentMsg.id);
    expect(body.content).toBe("hello from proxy");
    expect(client.captured.channelId).toBe("ch-1");
    expect(client.captured.contentType).toBe("application/json");
  });

  test("injects sent message into cache on success", async () => {
    const cache = createCache(TEST_TTL, TEST_WINDOW);
    const now = Date.now();
    const msgId = timestampToSnowflake(now);
    const sentMsg: DiscordMessage = {
      id: msgId,
      channel_id: "ch-1",
      content: "cached after send",
      timestamp: new Date().toISOString(),
      author: { id: "u-1", username: "bot" },
    };

    const client = mockClient({
      ok: true,
      status: 200,
      headers: new Headers(),
      body: sentMsg,
    });

    const handler = createHandler(cache, "guild-1", TEST_TTL, client);
    const req = new Request(
      "http://localhost/api/v10/channels/ch-1/messages",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "cached after send" }),
      },
    );

    await handler(req);

    // The message should now be in the cache
    const afterId = timestampToSnowflake(now - 60_000);
    const cached = cache.getMessages("ch-1", afterId);
    expect(cached).toBeDefined();
    expect(cached!.data).toHaveLength(1);
    expect(cached!.data[0].id).toBe(msgId);
    expect(cached!.data[0].content).toBe("cached after send");
  });

  test("does NOT inject into cache on Discord error", async () => {
    const cache = createCache(TEST_TTL, TEST_WINDOW);
    const client = mockClient({
      ok: false,
      status: 403,
      headers: new Headers(),
      body: { message: "Missing Permissions", code: 50013 },
    });

    const handler = createHandler(cache, "guild-1", TEST_TTL, client);
    const req = new Request(
      "http://localhost/api/v10/channels/ch-1/messages",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "forbidden" }),
      },
    );

    const res = await handler(req);

    expect(res.status).toBe(403);
    // Cache should remain empty for this channel
    const cached = cache.getMessages("ch-1", "0");
    expect(cached).toBeUndefined();
  });

  test("forwards multipart/form-data content-type to Discord client", async () => {
    const cache = createCache(TEST_TTL, TEST_WINDOW);
    const sentMsg: DiscordMessage = {
      id: timestampToSnowflake(Date.now()),
      channel_id: "ch-1",
      content: "with attachment",
      timestamp: new Date().toISOString(),
      author: { id: "u-1", username: "bot" },
    };

    const client = mockClient({
      ok: true,
      status: 200,
      headers: new Headers(),
      body: sentMsg,
    });

    const boundary = "----testboundary";
    const multipartBody =
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="content"\r\n\r\n` +
      `with attachment\r\n` +
      `--${boundary}--`;

    const handler = createHandler(cache, "guild-1", TEST_TTL, client);
    const req = new Request(
      "http://localhost/api/v10/channels/ch-1/messages",
      {
        method: "POST",
        headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
        body: multipartBody,
      },
    );

    const res = await handler(req);

    expect(res.status).toBe(200);
    expect(client.captured.contentType).toBe(
      `multipart/form-data; boundary=${boundary}`,
    );
    expect(client.captured.body).toContain("with attachment");
  });

  test("returns 503 when no Discord client is configured", async () => {
    const cache = createCache(TEST_TTL, TEST_WINDOW);
    // No client passed — write pass-through disabled
    const handler = createHandler(cache, "guild-1", TEST_TTL);
    const req = new Request(
      "http://localhost/api/v10/channels/ch-1/messages",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "test" }),
      },
    );

    const res = await handler(req);

    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toContain("not configured");
  });

  describe("creation pass-through (#18)", () => {
    test("forwards create-channel POST to Discord, returns 201 verbatim", async () => {
      const cache = createCache(TEST_TTL, TEST_WINDOW);
      const created = { id: "999", name: "new-chan", type: 0, guild_id: "guild-1" };
      const client = mockClient({
        ok: true,
        status: 201,
        headers: new Headers(),
        body: created,
      });

      const handler = createHandler(cache, "guild-1", TEST_TTL, client);
      const req = new Request("http://localhost/api/v10/guilds/guild-1/channels", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "new-chan" }),
      });

      const res = await handler(req);

      expect(res.status).toBe(201);
      const body = (await res.json()) as { id: string; name: string };
      expect(body.id).toBe("999");
      // The guild id (not a channel id) is what gets forwarded for create-channel
      expect(client.captured.channelId).toBe("guild-1");
      expect(client.captured.body).toContain("new-chan");
      expect(client.captured.contentType).toBe("application/json");
    });

    test("forwards create-thread POST to Discord, returns verbatim (mcp#47)", async () => {
      const cache = createCache(TEST_TTL, TEST_WINDOW);
      const created = { id: "1001", name: "thread-1", type: 11, parent_id: "ch-1" };
      const client = mockClient({
        ok: true,
        status: 201,
        headers: new Headers(),
        body: created,
      });

      const handler = createHandler(cache, "guild-1", TEST_TTL, client);
      const req = new Request("http://localhost/api/v10/channels/ch-1/threads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "thread-1" }),
      });

      const res = await handler(req);

      expect(res.status).toBe(201);
      const body = (await res.json()) as { id: string };
      expect(body.id).toBe("1001");
      expect(client.captured.channelId).toBe("ch-1");
    });

    test("create-channel returns 503 when no Discord client is configured", async () => {
      const cache = createCache(TEST_TTL, TEST_WINDOW);
      const handler = createHandler(cache, "guild-1", TEST_TTL);
      const req = new Request("http://localhost/api/v10/guilds/guild-1/channels", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "x" }),
      });

      const res = await handler(req);

      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.error).toContain("not configured");
    });

    test("passes a Discord error status through verbatim on creation", async () => {
      const cache = createCache(TEST_TTL, TEST_WINDOW);
      const client = mockClient({
        ok: false,
        status: 403,
        headers: new Headers(),
        body: { message: "Missing Permissions", code: 50013 },
      });

      const handler = createHandler(cache, "guild-1", TEST_TTL, client);
      const req = new Request("http://localhost/api/v10/channels/ch-1/threads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "x" }),
      });

      const res = await handler(req);

      expect(res.status).toBe(403);
      const body = (await res.json()) as { code: number };
      expect(body.code).toBe(50013);
    });
  });

  describe("write rate-limit header forwarding (#19)", () => {
    test("forwards Discord rate-limit headers on a 429 create-channel", async () => {
      const cache = createCache(TEST_TTL, TEST_WINDOW);
      const client = mockClient({
        ok: false,
        status: 429,
        headers: new Headers({
          "Retry-After": "5",
          "X-RateLimit-Remaining": "0",
          "X-RateLimit-Global": "true",
          "Set-Cookie": "secret=should-not-leak",
        }),
        body: { message: "You are being rate limited.", retry_after: 5, global: true },
      });

      const handler = createHandler(cache, "guild-1", TEST_TTL, client);
      const req = new Request("http://localhost/api/v10/guilds/guild-1/channels", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "x" }),
      });

      const res = await handler(req);

      expect(res.status).toBe(429);
      expect(res.headers.get("Retry-After")).toBe("5");
      expect(res.headers.get("X-RateLimit-Remaining")).toBe("0");
      expect(res.headers.get("X-RateLimit-Global")).toBe("true");
      // Allowlist boundary: non-rate-limit edge headers must NOT leak through
      expect(res.headers.get("Set-Cookie")).toBeNull();
    });

    test("forwards rate-limit headers on the message-send path too (shared write response)", async () => {
      const cache = createCache(TEST_TTL, TEST_WINDOW);
      const client = mockClient({
        ok: false,
        status: 429,
        headers: new Headers({ "Retry-After": "3", "Set-Cookie": "nope" }),
        body: { message: "You are being rate limited.", retry_after: 3 },
      });

      const handler = createHandler(cache, "guild-1", TEST_TTL, client);
      const req = new Request("http://localhost/api/v10/channels/ch-1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "x" }),
      });

      const res = await handler(req);

      expect(res.status).toBe(429);
      expect(res.headers.get("Retry-After")).toBe("3");
      expect(res.headers.get("Set-Cookie")).toBeNull();
    });
  });

  describe("webhook pass-through (#23)", () => {
    test("GET webhooks list forwards live, body verbatim incl. token", async () => {
      const cache = createCache(TEST_TTL, TEST_WINDOW);
      const webhooks = [
        { id: "wh-1", name: "cc-fleet", token: "SECRET-TOKEN-abc", channel_id: "ch-1" },
      ];
      const client = mockClient({
        ok: true,
        status: 200,
        headers: new Headers(),
        body: webhooks,
      });

      const handler = createHandler(cache, "guild-1", TEST_TTL, client);
      const req = new Request("http://localhost/api/v10/channels/ch-1/webhooks", {
        method: "GET",
      });

      const res = await handler(req);

      expect(res.status).toBe(200);
      const body = (await res.json()) as Array<{ id: string; token: string }>;
      // The token MUST survive — disc-server reuses the webhook by reading it
      expect(body[0].token).toBe("SECRET-TOKEN-abc");
      expect(client.captured.channelId).toBe("ch-1");
    });

    test("POST create webhook forwards, 201 verbatim", async () => {
      const cache = createCache(TEST_TTL, TEST_WINDOW);
      const client = mockClient({
        ok: true,
        status: 201,
        headers: new Headers(),
        body: { id: "wh-2", token: "new-tok" },
      });

      const handler = createHandler(cache, "guild-1", TEST_TTL, client);
      const req = new Request("http://localhost/api/v10/channels/ch-1/webhooks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "cc-fleet" }),
      });

      const res = await handler(req);

      expect(res.status).toBe(201);
      const body = (await res.json()) as { id: string };
      expect(body.id).toBe("wh-2");
      expect(client.captured.channelId).toBe("ch-1");
      expect(client.captured.body).toContain("cc-fleet");
    });

    test("POST execute webhook forwards with ?wait=true preserved, 200 verbatim", async () => {
      const cache = createCache(TEST_TTL, TEST_WINDOW);
      const sent = { id: "msg-1", channel_id: "ch-1", content: "via webhook" };
      const client = mockClient({
        ok: true,
        status: 200,
        headers: new Headers(),
        body: sent,
      });

      const handler = createHandler(cache, "guild-1", TEST_TTL, client);
      const req = new Request(
        "http://localhost/api/v10/webhooks/wh-1/SECRET-TOKEN-abc?wait=true",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: "via webhook", username: "cacophonix" }),
        },
      );

      const res = await handler(req);

      expect(res.status).toBe(200);
      const body = (await res.json()) as { id: string };
      expect(body.id).toBe("msg-1");
      expect(client.captured.channelId).toBe("wh-1"); // webhookId recorded
      expect(client.captured.search).toBe("?wait=true"); // query preserved
      expect(client.captured.body).toContain("cacophonix");
    });

    // Parameterised over EVERY status in NULL_BODY_STATUSES, not just 204.
    // The constant's docblock claims all four throw if given a body; only 204
    // had a test behind it, so removing 101/205/304 from the set changed
    // nothing observable. The claim covers four statuses, so the check does too.
    test.each([101, 204, 205, 304])(
      "execute webhook %i returns empty body without throwing (#22)",
      async (status) => {
        const cache = createCache(TEST_TTL, TEST_WINDOW);
        const client = mockClient({
          ok: true,
          status,
          headers: new Headers({ "Retry-After": "1" }),
          body: "",
        });

        const handler = createHandler(cache, "guild-1", TEST_TTL, client);
        const req = new Request(
          "http://localhost/api/v10/webhooks/wh-1/tok",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ content: "x" }),
          },
        );

        const res = await handler(req);

        expect(res.status).toBe(status);
        expect(await res.text()).toBe("");
        // rate-limit headers still forwarded on a null-body status
        expect(res.headers.get("Retry-After")).toBe("1");
      },
    );

    // Pins "webhook tokens must not be cached/staled" (index.ts, webhook-list
    // route). True by construction today — nothing on that path touches the
    // cache — but nothing HELD it there: adding a working cache left the suite
    // green. A stale webhook token is a live credential that has been revoked
    // upstream, so this is a correctness claim, not a freshness preference.
    test("webhook list forwards live on every call — never cached", async () => {
      const cache = createCache(TEST_TTL, TEST_WINDOW);
      const client = mockClient({
        ok: true,
        status: 200,
        headers: new Headers(),
        body: [{ id: "wh-1", token: "secret-token" }],
      });
      let calls = 0;
      client.listWebhooks = async () => {
        calls += 1;
        return { ok: true, status: 200, headers: new Headers(), body: [{ id: "wh-1" }] };
      };

      const handler = createHandler(cache, "guild-1", TEST_TTL, client);
      const req = () =>
        new Request("http://localhost/api/v10/channels/ch-1/webhooks");

      await handler(req());
      await handler(req());

      // Two requests ⇒ two upstream calls. A cache would make this 1.
      expect(calls).toBe(2);
    });

    test("webhook routes return 503 when no Discord client is configured", async () => {
      const cache = createCache(TEST_TTL, TEST_WINDOW);
      const handler = createHandler(cache, "guild-1", TEST_TTL); // no client
      for (const req of [
        new Request("http://localhost/api/v10/channels/ch-1/webhooks", { method: "GET" }),
        new Request("http://localhost/api/v10/channels/ch-1/webhooks", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        }),
        new Request("http://localhost/api/v10/webhooks/wh-1/tok", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        }),
      ]) {
        const res = await handler(req);
        expect(res.status).toBe(503);
      }
    });
  });

  describe("single-message fetch (#25)", () => {
    test("forwards GET /messages/{messageId} to Discord and returns it verbatim", async () => {
      const cache = createCache(TEST_TTL, TEST_WINDOW);
      const msg = makeMessage("111222333444555666", "ch-1", "the forwarded one");
      const client = mockClient({
        ok: true,
        status: 200,
        headers: new Headers(),
        body: msg,
      });

      const handler = createHandler(cache, "guild-1", TEST_TTL, client);
      const res = await handler(
        new Request("http://localhost/api/v10/channels/ch-1/messages/111222333444555666"),
      );

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(msg);
      expect(client.captured.channelId).toBe("ch-1");
      expect(client.captured.messageId).toBe("111222333444555666");
    });

    // The whole point of the route: a deleted message must surface Discord's own
    // 404 body, not the proxy catch-all's. Callers key on that distinction to tell
    // "deleted" from "the proxy does not route this".
    test("passes through Discord's real 404 for a deleted message", async () => {
      const cache = createCache(TEST_TTL, TEST_WINDOW);
      const client = mockClient({
        ok: false,
        status: 404,
        headers: new Headers(),
        body: { message: "Unknown Message", code: 10008 },
      });

      const handler = createHandler(cache, "guild-1", TEST_TTL, client);
      const res = await handler(
        new Request("http://localhost/api/v10/channels/ch-1/messages/222333444555666777"),
      );

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ message: "Unknown Message", code: 10008 });
    });

    // Load-bearing: serving this from cache would report a message deleted
    // upstream as still present, inverting the caller's deleted-vs-transient
    // discrimination. Seed the cache with the exact id, then assert we still
    // hit Discord and return Discord's answer rather than the cached copy.
    test("never serves from cache — forwards live even when the id is cached", async () => {
      const cache = createCache(TEST_TTL, TEST_WINDOW);
      const cachedId = timestampToSnowflake(Date.now() - 60_000);
      cache.setMessages("ch-1", [makeMessage(cachedId, "ch-1", "stale copy")]);

      const client = mockClient({
        ok: false,
        status: 404,
        headers: new Headers(),
        body: { message: "Unknown Message", code: 10008 },
      });

      const handler = createHandler(cache, "guild-1", TEST_TTL, client);
      const res = await handler(
        new Request(`http://localhost/api/v10/channels/ch-1/messages/${cachedId}`),
      );

      expect(client.captured.messageId).toBe(cachedId);
      expect(res.status).toBe(404);
      expect(res.headers.get("X-Cache")).toBeNull();
    });

    test("forwards allowlisted rate-limit headers", async () => {
      const cache = createCache(TEST_TTL, TEST_WINDOW);
      const client = mockClient({
        ok: false,
        status: 429,
        headers: new Headers({
          "Retry-After": "2",
          "X-RateLimit-Bucket": "abc",
          "Set-Cookie": "leak=nope",
        }),
        body: { message: "You are being rate limited.", retry_after: 2 },
      });

      const handler = createHandler(cache, "guild-1", TEST_TTL, client);
      const res = await handler(
        new Request("http://localhost/api/v10/channels/ch-1/messages/333444555666777888"),
      );

      expect(res.status).toBe(429);
      expect(res.headers.get("Retry-After")).toBe("2");
      expect(res.headers.get("X-RateLimit-Bucket")).toBe("abc");
      expect(res.headers.get("Set-Cookie")).toBeNull();
    });

    test("returns 503 when no Discord client is configured", async () => {
      const cache = createCache(TEST_TTL, TEST_WINDOW);
      const handler = createHandler(cache, "guild-1", TEST_TTL); // no client
      const res = await handler(
        new Request("http://localhost/api/v10/channels/ch-1/messages/333444555666777888"),
      );

      expect(res.status).toBe(503);
    });

    // A malformed id must NOT be forwarded: Discord would answer its own 404,
    // which callers read as "deleted" and drop silently — the same disappearance
    // this route exists to stop, just triggered by a typo instead of a route gap.
    // 400 is read as an error, so the message survives.
    test("rejects a non-snowflake messageId instead of forwarding it", async () => {
      const cache = createCache(TEST_TTL, TEST_WINDOW);
      const client = mockClient({
        ok: true,
        status: 200,
        headers: new Headers(),
        body: {},
      });
      const handler = createHandler(cache, "guild-1", TEST_TTL, client);

      for (const bad of ["not-a-snowflake", "12a", "%2F..", "-1"]) {
        const res = await handler(
          new Request(`http://localhost/api/v10/channels/ch-1/messages/${bad}`),
        );
        expect(res.status).toBe(400);
      }

      // Never reached the client — the guard runs before any upstream call.
      expect(client.captured.messageId).toBe("");
    });

    // Documents why the guard is NOT a path-traversal defense: `new URL()` collapses
    // dot segments before the router sees them, so `..` can never arrive AS a
    // messageId. Pinned so nobody later "hardens" the regex against a threat that
    // the URL parser has already made unreachable.
    test("dot segments are collapsed by URL parsing before routing", async () => {
      for (const seg of ["..", "%2e%2e", "%2E%2E"]) {
        const url = new URL(
          `http://localhost/api/v10/channels/ch-1/messages/${seg}`,
        );
        expect(url.pathname).toBe("/api/v10/channels/ch-1/");
      }
    });

    // Regression guard for the original defect: the LIST route's `$` anchor made
    // this path fall through to the catch-all.
    //
    // Asserted POSITIVELY — on the routed response we expect — not negatively on
    // the catch-all body we don't. An earlier version of this test checked
    // `not.toMatchObject({error: "not found"})`, and changing the catch-all body
    // silently made it unfalsifiable: it passed whether the route worked or fell
    // through. A regression guard phrased as "not the old wrong answer" dies the
    // moment the wrong answer is reworded, and dies green.
    test("does not fall through to the catch-all", async () => {
      const cache = createCache(TEST_TTL, TEST_WINDOW);
      const client = mockClient({
        ok: true,
        status: 200,
        headers: new Headers(),
        body: makeMessage("444555666777888999", "ch-1", "routed"),
      });

      const handler = createHandler(cache, "guild-1", TEST_TTL, client);
      const res = await handler(
        new Request("http://localhost/api/v10/channels/ch-1/messages/444555666777888999"),
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.id).toBe("444555666777888999");
      expect(body.content).toBe("routed");
      // No `proxy` key ⇒ this came from Discord, not from our own error path.
      expect(body.proxy).toBeUndefined();
    });
  });
});

describe("unknown routes", () => {
  // #25: an unrouted path must NOT answer 404. This proxy fronts Discord, so a
  // 404 from here is byte-comparable to Discord's own "Unknown Message" and gets
  // read as "the resource was deleted" — the exact confusion that silently
  // dropped forwarded messages. 501 is the honest answer: we never asked the
  // origin, we just don't serve this path.
  test("returns 501 (not 404) for an unknown path", async () => {
    const cache = createCache(TEST_TTL, TEST_WINDOW);
    const handler = createHandler(cache, "guild-1");
    const req = new Request("http://localhost/unknown", { method: "GET" });
    const res = await handler(req);

    expect(res.status).toBe(501);
    expect(res.status).not.toBe(404);

    const body = await res.json();
    expect(body.error).toBe("no route for this path");
  });

  // Consumers must be able to identify a proxy miss by a key that is PRESENT,
  // not by the absence of Discord's `code`. Absence-based discrimination flips
  // silently if either body shape ever grows a field; this pins the positive form.
  test("self-identifies as the proxy rather than relying on absence", async () => {
    const cache = createCache(TEST_TTL, TEST_WINDOW);
    const handler = createHandler(cache, "guild-1");
    const res = await handler(new Request("http://localhost/unknown"));

    const body = (await res.json()) as Record<string, unknown>;
    expect(body.proxy).toBe("scream-hole");
    // Must never look like a Discord error body.
    expect(body.code).toBeUndefined();
    expect(body.message).toBeUndefined();
  });

  // An unrouted path under a *routed* prefix is the shape that caused #25 — the
  // `$`-anchored messages regex let the extra segment fall through here.
  test("an unrouted subpath under a routed prefix also returns 501", async () => {
    const cache = createCache(TEST_TTL, TEST_WINDOW);
    const handler = createHandler(cache, "guild-1");
    const res = await handler(
      new Request("http://localhost/api/v10/channels/ch-1/messages/123/reactions"),
    );

    expect(res.status).toBe(501);
  });

  // Unrouted *verbs* on a routed path fall here too. Message edit/delete are the
  // most likely routes to be added next, so pin where they land today.
  test.each(["DELETE", "PATCH", "PUT"])(
    "%s on a routed path returns 501",
    async (method) => {
      const cache = createCache(TEST_TTL, TEST_WINDOW);
      const handler = createHandler(cache, "guild-1");
      const res = await handler(
        new Request(
          "http://localhost/api/v10/channels/ch-1/messages/111222333444555666",
          { method },
        ),
      );

      expect(res.status).toBe(501);
    },
  );
});

// The contract the README documents: consumers identify a proxy-origin answer by
// the PRESENCE of `proxy`. That only works if it holds for every error we
// construct — one route omitting it recreates #25 on that route, which is what
// happened to the uncached-guild 404 when the rule was first written down.
//
// The rows below cover every route-level error site. That claim is not left to
// prose: `proxyError call sites are all covered` derives the count from the
// source, so adding a site without adding a row fails the suite. An earlier
// version of this header asserted exhaustiveness in a comment while a site was
// in fact uncovered — a false exhaustiveness claim is worse than an acknowledged
// gap, because the next reader trusts it instead of checking.
describe("proxy-origin error contract (#25)", () => {
  test("proxyError call sites are all covered by a row or an attribution test", async () => {
    const src = await Bun.file(
      new URL("../index.ts", import.meta.url).pathname,
    ).text();
    // Call sites only: `return proxyError(` at a statement position. A bare
    // /\bproxyError\(/ also matches occurrences inside comments and string
    // literals — there are none today, but a future doc comment mentioning
    // `proxyError(...)` would inflate the count and red the suite with a
    // misleading failure. Anchoring on `return ` also excludes the definition,
    // so no off-by-one adjustment is needed.
    const sites = [...src.matchAll(/return proxyError\(/g)].length;

    // 2 handler-level sites (the neutral 500 and the upstream 502) are covered by
    // the "upstream failure is attributable" describe, not by a table row.
    const HANDLER_LEVEL = 2;
    // Rows that share a site with another row: the `after` 400 site serves both
    // the missing-`after` and malformed-`after` cases. (Deliberately not cited by
    // line number — those go stale silently, and this comment is what a reader
    // consults to decide whether the constant is still right.)
    const DUPLICATE_COVERAGE_ROWS = 1;

    // DERIVED from the source count rather than pinned independently. An earlier
    // version asserted two literals against two separate sources with nothing
    // tying them to each other, so adding a site AND bumping the constant passed
    // green. Deriving the row count removes that particular hole.
    expect(cases.length).toBe(sites - HANDLER_LEVEL + DUPLICATE_COVERAGE_ROWS);

    // LIMITS OF THIS CHECK — stated here because a reader deciding whether to
    // trust it is standing here, and because an earlier version of this comment
    // overstated the guarantee, which is the failure this whole describe exists
    // to prevent:
    //   - It is a tripwire, NOT a proof. It counts sites and rows; it CANNOT
    //     verify that a row exercises the site it names. A row pointed at the
    //     wrong site still counts — a real bug this suite has already had once,
    //     which this check would not have caught.
    //   - TWO CONSTANTS REMAIN HAND-MAINTAINED. A new site can still be absorbed
    //     by bumping `HANDLER_LEVEL` or `DUPLICATE_COVERAGE_ROWS` instead of
    //     adding a row. The check makes that a deliberate act, not an invisible
    //     one — it does not make it impossible. Nothing anchors
    //     `DUPLICATE_COVERAGE_ROWS` to the actual number of shared sites.
    //   - Per-site coverage rests on mutation runs done BY HAND (bypassing the
    //     helper at one site and confirming exactly the row naming it fails).
    //     NOTHING IN THIS SUITE RERUNS THEM. If you change the table, redo them.
  });

  // Each case pins the STATUS it should produce, not just the marker. Without
  // that, a case can reach a different site than intended and still pass: the
  // `bad messageId` case originally ran with no client, so the `!client` 503
  // guard fired before the snowflake check and it silently re-tested the
  // no-client path. Asserting the status is what makes each row hit its own site.
  //
  // `withClient` is REQUIRED on every row, never optional — and that is not
  // style. `test.each` passes an extra trailing argument beyond the row's own
  // elements, so an optional 4th param silently receives it and reads truthy on
  // every short row. That made all four no-client cases run WITH a client and
  // stop testing the 503 they name. A required field makes tsc reject a row that
  // omits it, which is how it was caught; arity-dependent binding is not.
  const cases: Array<[string, Request, number, boolean]> = [
    ["catch-all 501", new Request("http://localhost/unknown"), 501, false],
    [
      "uncached guild 404",
      new Request("http://localhost/api/v10/guilds/no-such-guild/channels"),
      404,
      false,
    ],
    [
      "missing `after` 400",
      new Request("http://localhost/api/v10/channels/ch-1/messages"),
      400,
      false,
    ],
    [
      "bad `after` 400",
      new Request("http://localhost/api/v10/channels/ch-1/messages?after=abc"),
      400,
      false,
    ],
    [
      "bad `limit` 400",
      new Request("http://localhost/api/v10/channels/ch-1/messages?after=0&limit=abc"),
      400,
      false,
    ],
    [
      "bad messageId 400",
      new Request("http://localhost/api/v10/channels/ch-1/messages/not-a-snowflake"),
      400,
      true,
    ],
    ["lease missing channel 400", new Request("http://localhost/lease/mic/status"), 400, false],
    [
      "lease missing holder 400",
      new Request("http://localhost/lease/mic/claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel: "ch-1" }), // no `holder`
      }),
      400,
      false,
    ],
    [
      "lease bad method 405",
      new Request("http://localhost/lease/mic/claim", { method: "DELETE" }),
      405,
      false,
    ],
    [
      "single-message no client 503",
      new Request("http://localhost/api/v10/channels/ch-1/messages/111222333444555666"),
      503,
      false,
    ],
    [
      "webhook list no client 503",
      new Request("http://localhost/api/v10/channels/ch-1/webhooks"),
      503,
      false,
    ],
    [
      "create-channel no client 503",
      new Request("http://localhost/api/v10/guilds/guild-1/channels", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      }),
      503,
      false,
    ],
    [
      "POST messages no client 503",
      new Request("http://localhost/api/v10/channels/ch-1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      }),
      503,
      false,
    ],
  ];

  test.each(cases)(
    "%s self-identifies as proxy-origin",
    async (_name, req, expectedStatus, withClient) => {
      const cache = createCache(TEST_TTL, TEST_WINDOW);
      const client = withClient
        ? mockClient({ ok: true, status: 200, headers: new Headers(), body: {} })
        : undefined;
      const handler = createHandler(cache, "guild-1", TEST_TTL, client);
      const res = await handler(req);

      // Pins that this row exercised the site it names, not a guard above it.
      expect(res.status).toBe(expectedStatus);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.proxy).toBe("scream-hole");
      // Must never be mistakable for a Discord error body.
      expect(body.code).toBeUndefined();
      expect(body.message).toBeUndefined();
    },
  );
});

// A rejected upstream fetch (DNS failure, connection reset, TLS error) must not
// escape as Bun's bare 500 — that carries no marker and is indistinguishable
// from Discord's own `{"message":"500: Internal Server Error","code":0}`, so a
// consumer would read OUR network failure as Discord's answer. Same confusion
// as #25, different costume.
describe("upstream failure is attributable (#25)", () => {
  test("a thrown upstream fetch becomes a marked 502, not a bare 500", async () => {
    const cache = createCache(TEST_TTL, TEST_WINDOW);
    const client = mockClient({
      ok: true,
      status: 200,
      headers: new Headers(),
      body: {},
    });
    client.fetchMessage = async () => {
      throw new TypeError("fetch failed: ECONNRESET");
    };

    const handler = createHandler(cache, "guild-1", TEST_TTL, client);
    const res = await handler(
      new Request("http://localhost/api/v10/channels/ch-1/messages/111222333444555666"),
    );

    expect(res.status).toBe(502);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.proxy).toBe("scream-hole");
    // Never mistakable for Discord's own 500 envelope.
    expect(body.code).toBeUndefined();
    expect(body.message).toBeUndefined();
  });

  // Pins the deliberate placement of `onResult` and `writeResponse` OUTSIDE
  // forwardUpstream's try. That placement carries a comment asserting "a throw
  // from here is OUR bug, not Discord's" — and nothing tested it: moving both
  // back inside the try left the suite green.
  //
  // The path is reachable, not theoretical. `writeResponse` calls
  // `JSON.stringify(result.body)`, which throws on a circular body or a throwing
  // `toJSON`; `onResult` dereferences `result.body`. Either would be reported as
  // an upstream failure — the exact mislabeling this file spends forty lines of
  // comment repudiating, in the comment that repudiates it.
  test("a throw while BUILDING the response is ours (500), never Discord's (502)", async () => {
    const cache = createCache(TEST_TTL, TEST_WINDOW);
    // Discord answered fine. We fail turning its answer into a Response.
    const client = mockClient({
      ok: true,
      status: 200,
      headers: new Headers(),
      body: {
        toJSON() {
          throw new Error("unserialisable body");
        },
      },
    });

    const handler = createHandler(cache, "guild-1", TEST_TTL, client);
    const res = await handler(
      new Request("http://localhost/api/v10/channels/ch-1/messages/111222333444555666"),
    );

    expect(res.status).toBe(500);
    expect(res.status).not.toBe(502);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.proxy).toBe("scream-hole");
    // Discord was reachable and answered — we must not blame it for our failure.
    expect(String(body.error)).not.toContain("upstream");
    expect(String(body.error)).not.toContain("Discord");
  });

  // The SECOND half of the same guarantee. The comment at forwardUpstream names
  // two statements outside the try — `onResult?.(result)` AND `writeResponse(result)`
  // — and the toJSON fixture above only reaches the second. Moving `onResult`
  // alone inside the try left the suite green, so the claim was broader than the
  // test.
  //
  // Reachable through the sole onResult caller, the message-send cache injection:
  // it does `result.body as DiscordMessage` then reads `msg.id`. A throwing `id`
  // getter is reported as 502 — blaming Discord for our own cache-injection fault
  // — under the mutated arrangement.
  test("a throw from the cache-injection hook is ours (500), never Discord's (502)", async () => {
    const cache = createCache(TEST_TTL, TEST_WINDOW);
    const hostileBody: Record<string, unknown> = {};
    Object.defineProperty(hostileBody, "id", {
      get() {
        throw new Error("id getter exploded");
      },
    });
    // Self-verifying, same standard as the other hostile fixtures: prove the
    // getter actually fires before relying on it.
    expect(() => (hostileBody as { id?: unknown }).id).toThrow();

    // ok:true so the injection branch is entered at all.
    const client = mockClient({
      ok: true,
      status: 200,
      headers: new Headers(),
      body: hostileBody,
    });

    const handler = createHandler(cache, "guild-1", TEST_TTL, client);
    const res = await handler(
      new Request("http://localhost/api/v10/channels/ch-1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "x" }),
      }),
    );

    expect(res.status).toBe(500);
    expect(res.status).not.toBe(502);
    expect(((await res.json()) as Record<string, unknown>).proxy).toBe("scream-hole");
  });

  // The complement, and the one that matters most: an INTERNAL fault must NOT be
  // labelled an upstream one. An earlier version wrapped the whole router in a
  // 502, so a cache throw on a cache-only route with no client configured came
  // back as "upstream Discord request failed" — on a request that never touched
  // Discord. Because the README tells consumers 502 is transient, a deterministic
  // internal bug would have been retried forever instead of surfacing.
  test("an internal fault is a neutral 500, never blamed on Discord", async () => {
    const cache = createCache(TEST_TTL, TEST_WINDOW);
    cache.getChannels = () => {
      throw new Error("cache corruption");
    };

    // No client at all — Discord is definitionally uncontactable on this path.
    const handler = createHandler(cache, "guild-1", TEST_TTL);
    const res = await handler(
      new Request("http://localhost/api/v10/guilds/guild-1/channels"),
    );

    expect(res.status).toBe(500);
    expect(res.status).not.toBe(502);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.proxy).toBe("scream-hole");
    // Must not assert an upstream failure it cannot know occurred.
    expect(String(body.error)).not.toContain("upstream");
    expect(String(body.error)).not.toContain("Discord");
  });

  /**
   * A net that can tear is not a net. Both guards read `.stack`/`.message` off an
   * arbitrary thrown value and stringify the result — every one of those steps
   * runs code the THROWER controls (a getter, a `toString`, a `Symbol.toPrimitive`,
   * a Proxy trap). An earlier version did the read and interpolation directly in
   * the catch, and hostile values tore straight through it.
   *
   * FIXTURES HERE ARE SELF-VERIFYING, and that is load-bearing. Two ways these
   * tests have already lied:
   *
   *   1. `class E extends Error { get stack() {...} }` never fires — Error
   *      instances carry an OWN `stack` that shadows a prototype getter. The
   *      fixture looked adversarial and was inert. Own-property form is required.
   *   2. Building the value INSIDE the throwing stub is self-masking: if
   *      construction itself throws, that error propagates exactly like the
   *      intended one and the assertion passes. The test is then satisfied by
   *      the very failure it exists to detect.
   *
   * So each case carries a `probe` that must demonstrably throw when applied to
   * the constructed value. The value is built OUTSIDE the stub and the probe is
   * asserted BEFORE the request. A fixture whose hostility fails to install now
   * fails the test instead of passing it.
   *
   * Cases with `probe: null` are declared INERT on purpose — they exercise the
   * branch that declines to touch the value at all. They are not hostile and are
   * labelled so nobody reads a uniformly-adversarial list.
   */
  type Hostile = {
    name: string;
    make: () => unknown;
    /** Applied to the built value; MUST throw, proving the hostility is live. */
    probe: ((v: unknown) => unknown) | null;
  };

  /** The outer guard reads `.stack`, falls back to `.message`, then stringifies. */
  const OUTER_GUARD_HOSTILES: Hostile[] = [
    {
      name: "own `stack` getter throws",
      make: () => {
        const e = new Error("boom");
        Object.defineProperty(e, "stack", {
          get() {
            throw new Error("stack getter exploded");
          },
        });
        return e;
      },
      probe: (v) => (v as { stack?: unknown }).stack,
    },
    {
      name: "`stack` is an object whose toString throws",
      make: () => {
        const e = new Error("boom");
        Object.defineProperty(e, "stack", {
          value: {
            toString() {
              throw new Error("toString exploded");
            },
          },
        });
        return e;
      },
      probe: (v) => String((v as { stack?: unknown }).stack),
    },
    {
      // The Symbol.toPrimitive mechanism is reachable through the VALUE of
      // `.stack`, not through the thrown object — an earlier case aimed it at the
      // thrown object, where `instanceof Error` is false and the value is never
      // touched, and a comment claimed it fired. It did not.
      name: "`stack` is an object whose Symbol.toPrimitive throws",
      make: () => {
        const e = new Error("boom");
        Object.defineProperty(e, "stack", {
          value: {
            [Symbol.toPrimitive]() {
              throw new Error("toPrimitive exploded");
            },
          },
        });
        return e;
      },
      probe: (v) => String((v as { stack?: unknown }).stack),
    },
    {
      name: "`stack` is a null-prototype object (String() throws)",
      make: () => {
        const e = new Error("boom");
        Object.defineProperty(e, "stack", { value: Object.create(null) });
        return e;
      },
      probe: (v) => String((v as { stack?: unknown }).stack),
    },
    {
      name: "no `stack`, and `message` getter throws",
      make: () => {
        const e = new Error("boom");
        Object.defineProperty(e, "stack", { value: undefined });
        Object.defineProperty(e, "message", {
          get() {
            throw new Error("message exploded");
          },
        });
        return e;
      },
      probe: (v) => (v as { message?: unknown }).message,
    },
    {
      // Attacks the guard's own machinery: `instanceof` consults getPrototypeOf
      // on a Proxy, which runs BEFORE any property read.
      name: "Proxy whose getPrototypeOf throws (breaks `instanceof`)",
      make: () =>
        new Proxy(
          {},
          {
            getPrototypeOf() {
              throw new Error("getPrototypeOf exploded");
            },
          },
        ),
      probe: (v) => v instanceof Error,
    },
    {
      name: "proxied Error whose get trap throws",
      make: () =>
        new Proxy(new Error("boom"), {
          get() {
            throw new Error("get trap exploded");
          },
        }),
      probe: (v) => (v as { stack?: unknown }).stack,
    },
    {
      name: "null-prototype thrown value",
      make: () => Object.create(null),
      probe: null, // instanceof false → literal substituted → value never touched
    },
    {
      name: "non-Error whose toString throws",
      make: () => ({
        toString() {
          throw new Error("toString exploded");
        },
      }),
      probe: null, // same branch — declines to touch the value
    },
  ];

  // Pins the sentence the entire fixture design rests on. Without this it is
  // folklore in a comment, and the first person who reads "these probes look
  // redundant" deletes them and silently reopens the self-masking hole.
  test("an Error's OWN `stack` shadows a prototype getter (why probes exist)", () => {
    let prototypeGetterFired = false;
    class ProtoGetter extends Error {
      get stack(): string {
        prototypeGetterFired = true;
        throw new Error("this never runs");
      }
    }

    const shadowed = new ProtoGetter("x");
    // Reading `.stack` hits the instance's OWN property, so the prototype getter
    // is never consulted — the fixture form that looks adversarial and is inert.
    expect(() => shadowed.stack).not.toThrow();
    expect(prototypeGetterFired).toBe(false);

    // The own-property form DOES fire. Every hostile fixture uses this form
    // because of the line above, not by style preference.
    let ownGetterFired = false;
    const own = new Error("x");
    Object.defineProperty(own, "stack", {
      get() {
        ownGetterFired = true;
        throw new Error("this fires");
      },
    });
    expect(() => own.stack).toThrow();
    expect(ownGetterFired).toBe(true);
  });

  describe("the last-resort guard cannot be torn", () => {
    test.each(OUTER_GUARD_HOSTILES.map((h) => [h.name, h] as const))(
      "%s still yields a marked 500",
      async (_name, h) => {
        const value = h.make();
        // Proves the fixture is live BEFORE it is used. Without this, a fixture
        // that failed to install its hostility would pass green.
        if (h.probe) expect(() => h.probe!(value)).toThrow();

        const cache = createCache(TEST_TTL, TEST_WINDOW);
        cache.getChannels = () => {
          throw value;
        };
        const handler = createHandler(cache, "guild-1", TEST_TTL);

        // Must not reject — a throw escaping here IS the failure being guarded.
        const res = await handler(
          new Request("http://localhost/api/v10/guilds/guild-1/channels"),
        );

        expect(res.status).toBe(500);
        expect(((await res.json()) as Record<string, unknown>).proxy).toBe("scream-hole");
      },
    );
  });

  /**
   * The 502's own logging must not cost us the 502. A throw while DESCRIBING an
   * upstream failure never produces a bare 500 — the outer guard catches it —
   * but it downgrades "Discord was unreachable" to "we broke", discarding the
   * attribution this path exists to provide.
   *
   * This guard reads `.message` only (never `.stack`), so its reachable hostile
   * space differs from the outer guard's and the cases are NOT copied across.
   * That cross-file claim is pinned by the test directly below — it was
   * previously asserted in prose with nothing checking it, so adding a `.stack`
   * read to `forwardUpstream` would have left this rationale silently wrong and
   * group B under-covered with no failure anywhere.
   */
  // A SOURCE-level check, deliberately. The behavioural version does not work:
  // because `forwardUpstream`'s logging is isolated, a throwing `.stack` getter
  // would be swallowed and the 502 returned anyway — the test would pass whether
  // or not the read was added. The isolation that makes the code robust is
  // exactly what makes the behaviour unable to witness this. So the claim is
  // checked where it is actually decidable: the source.
  //
  // LIMIT, stated adjacent per the rule: this pins that the identifier does not
  // appear in that function. It does not prove the reachable hostile space is
  // fully covered — only that the stated reason for group B's shape is still true.
  test("forwardUpstream reads `.message` only — group B's coverage rationale", async () => {
    const src = await Bun.file(
      new URL("../index.ts", import.meta.url).pathname,
    ).text();

    const start = src.indexOf("async function forwardUpstream(");
    expect(start).toBeGreaterThan(-1);
    // Function body ends at the first dedented closing brace at 2-space indent.
    const end = src.indexOf("\n  }\n", start);
    expect(end).toBeGreaterThan(start);
    const body = src.slice(start, end);

    expect(body).toContain("err.message");
    // If this fails, forwardUpstream grew a `.stack` read: add the stack-hostile
    // cases to UPSTREAM_HOSTILES before relaxing it.
    expect(body).not.toContain("err.stack");
  });

  const UPSTREAM_HOSTILES: Hostile[] = [
    {
      name: "Error whose message getter throws",
      make: () => {
        const e = new Error("x");
        Object.defineProperty(e, "message", {
          get() {
            throw new Error("message exploded");
          },
        });
        return e;
      },
      probe: (v) => (v as { message?: unknown }).message,
    },
    {
      name: "`message` is an object whose toString throws",
      make: () => {
        const e = new Error("x");
        Object.defineProperty(e, "message", {
          value: {
            toString() {
              throw new Error("toString exploded");
            },
          },
        });
        return e;
      },
      probe: (v) => String((v as { message?: unknown }).message),
    },
    {
      name: "Proxy whose getPrototypeOf throws (breaks `instanceof`)",
      make: () =>
        new Proxy(
          {},
          {
            getPrototypeOf() {
              throw new Error("getPrototypeOf exploded");
            },
          },
        ),
      probe: (v) => v instanceof Error,
    },
    {
      name: "proxied Error whose get trap throws",
      make: () =>
        new Proxy(new Error("x"), {
          get() {
            throw new Error("get trap exploded");
          },
        }),
      probe: (v) => (v as { message?: unknown }).message,
    },
    {
      name: "null-prototype thrown value",
      make: () => Object.create(null),
      probe: null, // instanceof false → literal substituted → value never touched
    },
    {
      name: "non-Error whose toString throws",
      make: () => ({
        toString() {
          throw new Error("toString exploded");
        },
      }),
      probe: null, // same branch
    },
  ];

  test.each(UPSTREAM_HOSTILES.map((h) => [h.name, h] as const))(
    "upstream 502 survives a hostile error value: %s",
    async (_name, h) => {
      const value = h.make();
      if (h.probe) expect(() => h.probe!(value)).toThrow();

      const cache = createCache(TEST_TTL, TEST_WINDOW);
      const client = mockClient({
        ok: true,
        status: 200,
        headers: new Headers(),
        body: {},
      });
      client.fetchMessage = async () => {
        throw value;
      };

      const handler = createHandler(cache, "guild-1", TEST_TTL, client);
      const res = await handler(
        new Request("http://localhost/api/v10/channels/ch-1/messages/111222333444555666"),
      );

      // 502, not 500 — the attribution must survive describing the failure.
      expect(res.status).toBe(502);
      expect(((await res.json()) as Record<string, unknown>).proxy).toBe("scream-hole");
    },
  );

  test("a write pass-through failure is also attributable", async () => {
    const cache = createCache(TEST_TTL, TEST_WINDOW);
    const client = mockClient({
      ok: true,
      status: 200,
      headers: new Headers(),
      body: {},
    });
    client.sendMessage = async () => {
      throw new Error("socket hang up");
    };

    const handler = createHandler(cache, "guild-1", TEST_TTL, client);
    const res = await handler(
      new Request("http://localhost/api/v10/channels/ch-1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "x" }),
      }),
    );

    expect(res.status).toBe(502);
    expect(((await res.json()) as Record<string, unknown>).proxy).toBe("scream-hole");
  });
});

// The README states that `/health` and `/lease/*` SUCCESSES are deliberately
// unmarked — Discord serves neither path, so provenance is never in question and
// stamping them would dilute what the marker means. That was documented with
// nothing holding it: marking them later would silently make the doc wrong and
// erode the marker's meaning, which is the whole reason it is trustworthy.
describe("deliberately unmarked surfaces (#25)", () => {
  test.each([
    ["/health", "/health"],
    ["lease status", "/lease/mic/status?channel=ch-1"],
  ])("%s success carries no proxy marker", async (_name, path) => {
    const cache = createCache(TEST_TTL, TEST_WINDOW);
    const handler = createHandler(cache, "guild-1", TEST_TTL);
    const res = await handler(new Request(`http://localhost${path}`));

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    // Not an oversight — these paths are off the Discord-impersonating surface.
    expect(body.proxy).toBeUndefined();
  });
});

// The success side of the same provenance question. Body-stamping cannot cover
// it — a cache read returns a bare Discord-shaped array with nowhere to put a
// key — so cache reads mark themselves in the HEADERS instead. A response
// forwarded from Discord carries neither marker, which is what makes "who
// answered me" decidable for every response on the Discord-impersonating surface.
describe("proxy-origin success markers (#25)", () => {
  test("cache-backed reads set X-Cache; forwarded responses never do", async () => {
    const cache = createCache(TEST_TTL, TEST_WINDOW);
    const now = Date.now();
    cache.setChannels("guild-1", [makeChannel("ch-1", "general")]);
    cache.setMessages("ch-1", [
      makeMessage(timestampToSnowflake(now - 60_000), "ch-1", "cached"),
    ]);
    const client = mockClient({
      ok: true,
      status: 200,
      headers: new Headers(),
      body: makeMessage("111222333444555666", "ch-1", "from discord"),
    });
    const handler = createHandler(cache, "guild-1", TEST_TTL, client);

    // Cache-backed reads — proxy-origin, so they mark themselves.
    for (const path of [
      "/api/v10/guilds/guild-1/channels",
      "/api/v10/channels/ch-1/messages?after=0",
      "/api/v10/channels/ch-99/messages?after=0", // fail-open 200 [] (#16)
    ]) {
      const res = await handler(new Request(`http://localhost${path}`));
      expect(res.status).toBe(200);
      expect(res.headers.get("X-Cache")).toBeTruthy();
    }

    // Forwarded from Discord — must carry no proxy marker of either kind.
    const forwarded = await handler(
      new Request("http://localhost/api/v10/channels/ch-1/messages/111222333444555666"),
    );
    expect(forwarded.status).toBe(200);
    expect(forwarded.headers.get("X-Cache")).toBeNull();
    expect(((await forwarded.json()) as Record<string, unknown>).proxy).toBeUndefined();
  });
});
