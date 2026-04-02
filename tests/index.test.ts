import { describe, expect, test } from "bun:test";
import { createHandler, VERSION } from "../index";
import { createCache } from "../cache";
import type { DiscordChannel, DiscordMessage } from "../discord";

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

describe("GET /health", () => {
  test("returns 200 with status ok, uptime, version, and cache stats", async () => {
    const cache = createCache(TEST_TTL, TEST_WINDOW);
    const handler = createHandler(cache, "guild-1");
    const req = new Request("http://localhost/health", { method: "GET" });
    const res = handler(req);

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
    const res = handler(req);

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
    const res = handler(req);

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
    const res = handler(req);

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
    const res = handler(req);

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
    const res = handler(req);

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
    const res = handler(req);

    expect(res.status).toBe(200);
    expect(res.headers.get("X-Cache")).toBe("HIT");
    expect(res.headers.get("X-Cached-At")).toBeTruthy();

    const body = (await res.json()) as DiscordMessage[];
    expect(body).toHaveLength(2);
    expect(body[0].content).toBe("middle message");
    expect(body[1].content).toBe("new message");
  });

  test("returns empty array when `after` is older than cache window", async () => {
    const cache = createCache(TEST_TTL, TEST_WINDOW);
    const now = Date.now();

    // Message within the window
    const recentId = timestampToSnowflake(now - 60_000);
    cache.setMessages("ch-1", [
      makeMessage(recentId, "ch-1", "recent"),
    ]);

    // `after` pointing to 5 hours ago — outside 4-hour window
    const oldId = timestampToSnowflake(now - 5 * 60 * 60 * 1000);

    const handler = createHandler(cache, "guild-1");
    const req = new Request(
      `http://localhost/api/v10/channels/ch-1/messages?after=${oldId}`,
    );
    const res = handler(req);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual([]);
  });

  test("returns 404 for unknown channel", async () => {
    const cache = createCache(TEST_TTL, TEST_WINDOW);
    const handler = createHandler(cache, "guild-1");

    const req = new Request(
      "http://localhost/api/v10/channels/unknown-ch/messages?after=100",
    );
    const res = handler(req);

    expect(res.status).toBe(404);
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
    const res = handler(req);

    expect(res.status).toBe(200);
    const body = (await res.json()) as DiscordMessage[];
    expect(body).toHaveLength(2);
    // Should return the 2 newest
    expect(body[0].content).toBe("msg-2");
    expect(body[1].content).toBe("msg-3");
  });
});

describe("unknown routes", () => {
  test("returns 404 for unknown path", async () => {
    const cache = createCache(TEST_TTL, TEST_WINDOW);
    const handler = createHandler(cache, "guild-1");
    const req = new Request("http://localhost/unknown", { method: "GET" });
    const res = handler(req);

    expect(res.status).toBe(404);

    const body = await res.json();
    expect(body.error).toBe("not found");
  });
});
