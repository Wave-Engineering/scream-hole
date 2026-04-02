import { describe, expect, test } from "bun:test";
import { createDiscordClient } from "../discord";
import type { FetchFn, DiscordChannel, DiscordMessage } from "../discord";

describe("Discord client — fetchChannels", () => {
  test("fetches channels for a guild with auth header", async () => {
    const channels: DiscordChannel[] = [
      { id: "ch-1", type: 0, name: "general" },
      { id: "ch-2", type: 2, name: "voice" },
    ];

    let capturedHeaders: Headers | undefined;
    const fakeFetch: FetchFn = async (_input, init) => {
      capturedHeaders = new Headers(init?.headers ?? {});
      return new Response(JSON.stringify(channels), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    const client = createDiscordClient("test-token", fakeFetch);
    const result = await client.fetchChannels("guild-1");

    expect(result).toHaveLength(2);
    expect(result[0].id).toBe("ch-1");
    expect(capturedHeaders?.get("Authorization")).toBe("Bot test-token");
  });

  test("throws on non-200 response", async () => {
    const fakeFetch: FetchFn = async () => {
      return new Response(JSON.stringify({ message: "Unauthorized" }), {
        status: 401,
        statusText: "Unauthorized",
      });
    };

    const client = createDiscordClient("bad-token", fakeFetch);
    await expect(client.fetchChannels("guild-1")).rejects.toThrow(
      "Failed to fetch channels",
    );
  });
});

describe("Discord client — fetchMessages", () => {
  test("fetches messages for a channel", async () => {
    const messages: DiscordMessage[] = [
      {
        id: "msg-1",
        channel_id: "ch-1",
        content: "hello",
        timestamp: new Date().toISOString(),
        author: { id: "u-1", username: "user1" },
      },
    ];

    const fakeFetch: FetchFn = async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      expect(url).toContain("/channels/ch-1/messages?limit=50");
      return new Response(JSON.stringify(messages), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    const client = createDiscordClient("test-token", fakeFetch);
    const result = await client.fetchMessages("ch-1");

    expect(result).toHaveLength(1);
    expect(result[0].content).toBe("hello");
  });

  test("respects custom limit parameter", async () => {
    const fakeFetch: FetchFn = async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      expect(url).toContain("limit=10");
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    const client = createDiscordClient("test-token", fakeFetch);
    await client.fetchMessages("ch-1", 10);
  });
});

describe("Discord client — rate limiting", () => {
  test("retries after 429 with Retry-After header", async () => {
    let callCount = 0;
    const messages: DiscordMessage[] = [
      {
        id: "msg-1",
        channel_id: "ch-1",
        content: "after retry",
        timestamp: new Date().toISOString(),
        author: { id: "u-1", username: "user1" },
      },
    ];

    const fakeFetch: FetchFn = async () => {
      callCount++;
      if (callCount === 1) {
        // First call: rate limited
        return new Response(JSON.stringify({ message: "Rate limited" }), {
          status: 429,
          headers: {
            "Retry-After": "0.01", // 10ms for fast test
            "Content-Type": "application/json",
          },
        });
      }
      // Second call: success
      return new Response(JSON.stringify(messages), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    const client = createDiscordClient("test-token", fakeFetch);
    const result = await client.fetchMessages("ch-1");

    expect(callCount).toBe(2);
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe("after retry");
  });
});
