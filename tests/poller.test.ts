import { describe, expect, test } from "bun:test";
import { initialPoll, createLogger, withTimeout } from "../poller";
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

    const count = await initialPoll(client, cache, "guild-1", logger);

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
    };

    const cache = createCache(60_000, 4 * 60 * 60 * 1000);
    const logger = createLogger("error");

    const count = await initialPoll(client, cache, "guild-1", logger);
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
    };

    const cache = createCache(60_000, 4 * 60 * 60 * 1000);
    const logger = createLogger("error");

    const count = await initialPoll(client, cache, "guild-1", logger);
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
