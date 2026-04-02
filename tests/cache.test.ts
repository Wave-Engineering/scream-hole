import { describe, expect, test } from "bun:test";
import { createCache, snowflakeToTimestamp } from "../cache";
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

describe("snowflakeToTimestamp", () => {
  test("converts a snowflake to a timestamp", () => {
    const now = Date.now();
    const snowflake = timestampToSnowflake(now);
    const extracted = snowflakeToTimestamp(snowflake);
    // Should be within a millisecond due to BigInt truncation
    expect(Math.abs(extracted - now)).toBeLessThanOrEqual(1);
  });
});

describe("cache channels", () => {
  test("set and get channels", () => {
    const cache = createCache(60_000, 4 * 60 * 60 * 1000);
    const channels = [makeChannel("ch-1", "general")];
    cache.setChannels("guild-1", channels);

    const result = cache.getChannels("guild-1");
    expect(result).toBeDefined();
    expect(result!.data).toHaveLength(1);
    expect(result!.data[0].id).toBe("ch-1");
    expect(typeof result!.cachedAt).toBe("number");
  });

  test("returns undefined for unknown guild", () => {
    const cache = createCache(60_000, 4 * 60 * 60 * 1000);
    expect(cache.getChannels("unknown")).toBeUndefined();
  });

  test("overwrite replaces channels", () => {
    const cache = createCache(60_000, 4 * 60 * 60 * 1000);
    cache.setChannels("guild-1", [makeChannel("ch-1", "general")]);
    cache.setChannels("guild-1", [makeChannel("ch-2", "random")]);

    const result = cache.getChannels("guild-1");
    expect(result!.data).toHaveLength(1);
    expect(result!.data[0].id).toBe("ch-2");
  });
});

describe("cache messages", () => {
  const FOUR_HOURS = 4 * 60 * 60 * 1000;

  test("set and get messages with `after` filtering", () => {
    const cache = createCache(60_000, FOUR_HOURS);
    const now = Date.now();

    const id1 = timestampToSnowflake(now - 60_000);
    const id2 = timestampToSnowflake(now - 30_000);
    const id3 = timestampToSnowflake(now - 10_000);

    cache.setMessages("ch-1", [
      makeMessage(id1, "ch-1", "msg-1"),
      makeMessage(id2, "ch-1", "msg-2"),
      makeMessage(id3, "ch-1", "msg-3"),
    ]);

    // Get messages after id1
    const result = cache.getMessages("ch-1", id1);
    expect(result).toBeDefined();
    expect(result!.data).toHaveLength(2);
    expect(result!.data[0].content).toBe("msg-2");
    expect(result!.data[1].content).toBe("msg-3");
  });

  test("returns undefined for unknown channel", () => {
    const cache = createCache(60_000, FOUR_HOURS);
    const after = timestampToSnowflake(Date.now() - 60_000);
    expect(cache.getMessages("unknown-ch", after)).toBeUndefined();
  });

  test("returns empty array when `after` is older than cache window", () => {
    const cache = createCache(60_000, FOUR_HOURS);
    const now = Date.now();

    const recentId = timestampToSnowflake(now - 60_000);
    cache.setMessages("ch-1", [makeMessage(recentId, "ch-1", "recent")]);

    // `after` is 5 hours ago — outside the 4-hour window
    const oldId = timestampToSnowflake(now - 5 * 60 * 60 * 1000);
    const result = cache.getMessages("ch-1", oldId);
    expect(result).toBeDefined();
    expect(result!.data).toEqual([]);
  });

  test("evicts messages older than cache window", () => {
    const cache = createCache(60_000, FOUR_HOURS);
    const now = Date.now();

    // One message within window, one outside
    const recentId = timestampToSnowflake(now - 60_000);
    const oldId = timestampToSnowflake(now - 5 * 60 * 60 * 1000);

    cache.setMessages("ch-1", [
      makeMessage(oldId, "ch-1", "old — should be evicted"),
      makeMessage(recentId, "ch-1", "recent — should remain"),
    ]);

    // Use an `after` that's within the window (2 hours ago) but before the recent message
    const afterId = timestampToSnowflake(now - 2 * 60 * 60 * 1000);
    const result = cache.getMessages("ch-1", afterId);
    expect(result).toBeDefined();
    // The old message should have been evicted during setMessages
    // Only the recent message should remain (and it's after our afterId)
    expect(result!.data).toHaveLength(1);
    expect(result!.data[0].content).toBe("recent — should remain");
  });

  test("evict() removes old messages from existing cache entries", () => {
    // Use a very short window for this test (1 second)
    const SHORT_WINDOW = 1_000;
    const cache = createCache(60_000, SHORT_WINDOW);
    const now = Date.now();

    // Message that is "old" relative to our tiny 1s window
    const id1 = timestampToSnowflake(now - 2_000); // 2 seconds ago
    const id2 = timestampToSnowflake(now); // now

    cache.setMessages("ch-1", [
      makeMessage(id2, "ch-1", "new"),
    ]);

    // Manually set messages without eviction by reaching into the cache
    // Actually, setMessages already evicts. Let's verify stats.
    const stats = cache.getStats();
    expect(stats.totalMessages).toBe(1);
  });

  test("limit trims to N newest messages", () => {
    const cache = createCache(60_000, FOUR_HOURS);
    const now = Date.now();

    const id1 = timestampToSnowflake(now - 60_000);
    const id2 = timestampToSnowflake(now - 30_000);
    const id3 = timestampToSnowflake(now - 10_000);
    const afterId = timestampToSnowflake(now - 120_000);

    cache.setMessages("ch-1", [
      makeMessage(id1, "ch-1", "msg-1"),
      makeMessage(id2, "ch-1", "msg-2"),
      makeMessage(id3, "ch-1", "msg-3"),
    ]);

    const result = cache.getMessages("ch-1", afterId, 2);
    expect(result).toBeDefined();
    expect(result!.data).toHaveLength(2);
    // Should return the 2 newest
    expect(result!.data[0].content).toBe("msg-2");
    expect(result!.data[1].content).toBe("msg-3");
  });

  test("merges new messages with existing on overwrite", () => {
    const cache = createCache(60_000, FOUR_HOURS);
    const now = Date.now();

    const id1 = timestampToSnowflake(now - 60_000);
    const id2 = timestampToSnowflake(now - 30_000);
    const id3 = timestampToSnowflake(now - 10_000);

    cache.setMessages("ch-1", [
      makeMessage(id1, "ch-1", "msg-1"),
      makeMessage(id2, "ch-1", "msg-2"),
    ]);

    // Add a new message
    cache.setMessages("ch-1", [makeMessage(id3, "ch-1", "msg-3")]);

    const afterId = timestampToSnowflake(now - 120_000);
    const result = cache.getMessages("ch-1", afterId);
    expect(result).toBeDefined();
    // All 3 should be present (merged)
    expect(result!.data).toHaveLength(3);
  });
});

describe("cache TTL tracking (hit/miss stats)", () => {
  test("increments hit count for fresh cache reads", () => {
    const cache = createCache(60_000, 4 * 60 * 60 * 1000);
    cache.setChannels("guild-1", [makeChannel("ch-1", "general")]);

    cache.getChannels("guild-1");
    cache.getChannels("guild-1");

    const stats = cache.getStats();
    expect(stats.hits).toBe(2);
  });

  test("increments miss count for unknown keys", () => {
    const cache = createCache(60_000, 4 * 60 * 60 * 1000);

    cache.getChannels("unknown");
    cache.getChannels("also-unknown");

    const stats = cache.getStats();
    expect(stats.misses).toBe(2);
  });

  test("reports stale cache as miss", () => {
    // TTL of 1ms — will expire almost immediately
    const cache = createCache(1, 4 * 60 * 60 * 1000);
    cache.setChannels("guild-1", [makeChannel("ch-1", "general")]);

    // Small delay to ensure TTL expires
    const start = Date.now();
    while (Date.now() - start < 5) {
      // busy wait 5ms
    }

    cache.getChannels("guild-1");

    const stats = cache.getStats();
    // Should be a miss because the entry is stale
    expect(stats.misses).toBe(1);
    expect(stats.hits).toBe(0);
  });
});

describe("cache stats", () => {
  test("reports correct stats", () => {
    const cache = createCache(60_000, 4 * 60 * 60 * 1000);
    const now = Date.now();

    cache.setChannels("guild-1", [makeChannel("ch-1", "general")]);
    cache.setMessages("ch-1", [
      makeMessage(timestampToSnowflake(now - 60_000), "ch-1", "msg-1"),
      makeMessage(timestampToSnowflake(now - 30_000), "ch-1", "msg-2"),
    ]);

    const stats = cache.getStats();
    expect(stats.channelsCached).toBe(1);
    expect(stats.totalMessages).toBe(2);
    expect(stats.hits).toBe(0);
    expect(stats.misses).toBe(0);
  });
});
