import { describe, expect, test } from "bun:test";
import { initialPoll, createLogger, withTimeout, createChannelHealth } from "../poller";
import type { ChannelHealth } from "../poller";
import { createCache } from "../cache";
import type { DiscordClient, DiscordChannel, DiscordMessage } from "../discord";

function timestampToSnowflake(timestampMs: number): string {
  const discordEpoch = 1420070400000n;
  const ts = BigInt(timestampMs) - discordEpoch;
  return String(ts << 22n);
}

function makeMockClient(
  channels: DiscordChannel[],
  messagesByChannel: Record<string, DiscordMessage[]>,
): DiscordClient {
  return {
    async fetchChannels(): Promise<DiscordChannel[]> {
      return channels;
    },
    async fetchMessages(channelId: string): Promise<DiscordMessage[]> {
      return messagesByChannel[channelId] ?? [];
    },
    async sendMessage() {
      return { ok: true, status: 200, headers: new Headers(), body: {} };
    },
  };
}

describe("initialPoll", () => {
  test("populates cache with channels and messages", async () => {
    const now = Date.now();
    const id1 = timestampToSnowflake(now - 60_000);

    const channels: DiscordChannel[] = [
      { id: "ch-1", type: 0, name: "general" },
      { id: "ch-2", type: 2, name: "voice" }, // not text, should be skipped
    ];

    const messages: DiscordMessage[] = [
      {
        id: id1,
        channel_id: "ch-1",
        content: "hello",
        timestamp: new Date().toISOString(),
        author: { id: "u-1", username: "user1" },
      },
    ];

    const client = makeMockClient(channels, { "ch-1": messages });
    const cache = createCache(60_000, 4 * 60 * 60 * 1000);
    const logger = createLogger("error"); // suppress output in tests
    const health = createChannelHealth(15_000);

    const count = await initialPoll(client, cache, "guild-1", logger, health);

    expect(count).toBe(1); // only 1 text channel
    expect(cache.getChannels("guild-1")).toBeDefined();
    expect(cache.getChannels("guild-1")!.data).toHaveLength(2); // all channels stored

    const afterId = timestampToSnowflake(now - 120_000);
    const msgResult = cache.getMessages("ch-1", afterId);
    expect(msgResult).toBeDefined();
    expect(msgResult!.data).toHaveLength(1);
  });

  test("returns 0 and does not crash when client throws", async () => {
    const client: DiscordClient = {
      async fetchChannels(): Promise<DiscordChannel[]> {
        throw new Error("Network error");
      },
      async fetchMessages(): Promise<DiscordMessage[]> {
        throw new Error("Network error");
      },
      async sendMessage() {
        return { ok: true, status: 200, headers: new Headers(), body: {} };
      },
    };

    const cache = createCache(60_000, 4 * 60 * 60 * 1000);
    const logger = createLogger("error");
    const health = createChannelHealth(15_000);

    const count = await initialPoll(client, cache, "guild-1", logger, health);
    expect(count).toBe(0);
  });

  test("continues past channel message fetch failures", async () => {
    const now = Date.now();
    const channels: DiscordChannel[] = [
      { id: "ch-1", type: 0, name: "general" },
      { id: "ch-2", type: 0, name: "random" },
    ];

    const id1 = timestampToSnowflake(now - 60_000);

    const client: DiscordClient = {
      async fetchChannels(): Promise<DiscordChannel[]> {
        return channels;
      },
      async fetchMessages(channelId: string): Promise<DiscordMessage[]> {
        if (channelId === "ch-1") {
          throw new Error("Permission denied");
        }
        return [
          {
            id: id1,
            channel_id: "ch-2",
            content: "hello from ch-2",
            timestamp: new Date().toISOString(),
            author: { id: "u-1", username: "user1" },
          },
        ];
      },
      async sendMessage() {
        return { ok: true, status: 200, headers: new Headers(), body: {} };
      },
    };

    const cache = createCache(60_000, 4 * 60 * 60 * 1000);
    const logger = createLogger("error");
    const health = createChannelHealth(15_000);

    const count = await initialPoll(client, cache, "guild-1", logger, health);
    expect(count).toBe(2); // both text channels counted

    // ch-1 failed — should have no messages
    const afterId = timestampToSnowflake(now - 120_000);
    expect(cache.getMessages("ch-1", afterId)).toBeUndefined();

    // ch-2 succeeded
    const result = cache.getMessages("ch-2", afterId);
    expect(result).toBeDefined();
    expect(result!.data).toHaveLength(1);
  });
});

describe("withTimeout", () => {
  test("resolves when promise completes before timeout", async () => {
    const result = await withTimeout(
      Promise.resolve("done"),
      1000,
      "test",
    );
    expect(result).toBe("done");
  });

  test("rejects when promise exceeds timeout", async () => {
    const slow = new Promise<string>((resolve) =>
      setTimeout(() => resolve("too late"), 5000),
    );
    await expect(withTimeout(slow, 10, "slow op")).rejects.toThrow(
      "Timeout after 10ms",
    );
  });
});

describe("createChannelHealth", () => {
  test("shouldSkip returns false for unknown channels", () => {
    const health = createChannelHealth(15_000);
    expect(health.shouldSkip("unknown")).toBe(false);
  });

  test("shouldSkip returns true after failure", () => {
    const health = createChannelHealth(15_000);
    health.recordFailure("ch-1");
    expect(health.shouldSkip("ch-1")).toBe(true);
  });

  test("recordSuccess resets backoff", () => {
    const health = createChannelHealth(15_000);
    health.recordFailure("ch-1");
    expect(health.shouldSkip("ch-1")).toBe(true);

    const recovered = health.recordSuccess("ch-1");
    expect(recovered).toBe(true);
    expect(health.shouldSkip("ch-1")).toBe(false);
  });

  test("recordSuccess returns false for channels not previously failing", () => {
    const health = createChannelHealth(15_000);
    expect(health.recordSuccess("ch-1")).toBe(false);
  });

  test("consecutive failures increase backoff duration", () => {
    const health = createChannelHealth(1_000);

    const r1 = health.recordFailure("ch-1");
    expect(r1.failures).toBe(1);
    expect(r1.backoffMs).toBe(1_000); // 1s * 2^0

    const r2 = health.recordFailure("ch-1");
    expect(r2.failures).toBe(2);
    expect(r2.backoffMs).toBe(2_000); // 1s * 2^1

    const r3 = health.recordFailure("ch-1");
    expect(r3.failures).toBe(3);
    expect(r3.backoffMs).toBe(4_000); // 1s * 2^2
  });

  test("backoff caps at 16x poll interval", () => {
    const health = createChannelHealth(1_000);

    // Ramp up to the cap (failure 5 = exponent min(4,4) = 16x)
    for (let i = 0; i < 4; i++) {
      health.recordFailure("ch-1");
    }

    // Failure 5: cap first applies
    const atCap = health.recordFailure("ch-1");
    expect(atCap.failures).toBe(5);
    expect(atCap.backoffMs).toBe(16_000); // 1000 * 2^4

    // Failure 6: stays capped, doesn't grow
    const pastCap = health.recordFailure("ch-1");
    expect(pastCap.failures).toBe(6);
    expect(pastCap.backoffMs).toBe(16_000);
  });
});

describe("channel backoff in polling", () => {
  test("skips channels in backoff on subsequent polls", async () => {
    const now = Date.now();
    const channels: DiscordChannel[] = [
      { id: "ch-ok", type: 0, name: "general" },
      { id: "ch-fail", type: 0, name: "restricted" },
    ];

    const id1 = timestampToSnowflake(now - 60_000);
    const fetchCounts = new Map<string, number>();

    const client: DiscordClient = {
      async fetchChannels(): Promise<DiscordChannel[]> {
        return channels;
      },
      async fetchMessages(channelId: string): Promise<DiscordMessage[]> {
        fetchCounts.set(channelId, (fetchCounts.get(channelId) ?? 0) + 1);
        if (channelId === "ch-fail") {
          throw new Error("403 Forbidden");
        }
        return [
          {
            id: id1,
            channel_id: channelId,
            content: "hello",
            timestamp: new Date().toISOString(),
            author: { id: "u-1", username: "user1" },
          },
        ];
      },
      async sendMessage() {
        return { ok: true, status: 200, headers: new Headers(), body: {} };
      },
    };

    const cache = createCache(60_000, 4 * 60 * 60 * 1000);
    const logger = createLogger("error");
    const health = createChannelHealth(15_000);

    // First poll — both channels attempted
    await initialPoll(client, cache, "guild-1", logger, health);
    expect(fetchCounts.get("ch-ok")).toBe(1);
    expect(fetchCounts.get("ch-fail")).toBe(1);

    // Second poll immediately — ch-fail should be skipped (in backoff)
    await initialPoll(client, cache, "guild-1", logger, health);
    expect(fetchCounts.get("ch-ok")).toBe(2);
    expect(fetchCounts.get("ch-fail")).toBe(1); // NOT incremented
  });

  test("channel recovers after successful fetch", async () => {
    const now = Date.now();
    const channels: DiscordChannel[] = [
      { id: "ch-flaky", type: 0, name: "flaky" },
    ];

    const id1 = timestampToSnowflake(now - 60_000);
    const health = createChannelHealth(1); // 1ms backoff so it expires instantly

    // Seed a failure
    health.recordFailure("ch-flaky");

    // Wait for backoff to expire (1ms base * 2^0 = 1ms)
    await new Promise((r) => setTimeout(r, 5));

    const client: DiscordClient = {
      async fetchChannels(): Promise<DiscordChannel[]> {
        return channels;
      },
      async fetchMessages(): Promise<DiscordMessage[]> {
        return [
          {
            id: id1,
            channel_id: "ch-flaky",
            content: "back online",
            timestamp: new Date().toISOString(),
            author: { id: "u-1", username: "user1" },
          },
        ];
      },
      async sendMessage() {
        return { ok: true, status: 200, headers: new Headers(), body: {} };
      },
    };

    const cache = createCache(60_000, 4 * 60 * 60 * 1000);
    const logger = createLogger("error");

    await initialPoll(client, cache, "guild-1", logger, health);

    // Channel should no longer be in backoff
    expect(health.shouldSkip("ch-flaky")).toBe(false);
  });
});

describe("createLogger", () => {
  test("creates a logger that does not throw", () => {
    const logger = createLogger("debug");
    // These should not throw
    logger.debug("debug message");
    logger.info("info message");
    logger.warn("warn message");
    logger.error("error message");
  });
});
