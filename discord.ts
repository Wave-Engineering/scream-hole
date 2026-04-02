/**
 * Discord REST API client — authenticated fetch wrapper with rate limit handling.
 */

const DISCORD_API_BASE = "https://discord.com/api/v10";

export interface DiscordChannel {
  id: string;
  type: number;
  name?: string;
  guild_id?: string;
  position?: number;
  [key: string]: unknown;
}

export interface DiscordMessage {
  id: string;
  channel_id: string;
  content: string;
  timestamp: string;
  author: { id: string; username: string; [key: string]: unknown };
  [key: string]: unknown;
}

export interface SendMessageResponse {
  ok: boolean;
  status: number;
  headers: Headers;
  body: unknown;
}

export interface DiscordClient {
  fetchChannels(guildId: string): Promise<DiscordChannel[]>;
  fetchMessages(
    channelId: string,
    limit?: number,
  ): Promise<DiscordMessage[]>;
  sendMessage(
    channelId: string,
    body: BodyInit,
    contentType: string,
  ): Promise<SendMessageResponse>;
}

/** Minimal fetch signature — avoids Bun-specific `preconnect` property on `typeof fetch`. */
export type FetchFn = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

/**
 * Create a Discord REST client with authenticated fetch and rate limit handling.
 *
 * @param botToken - Discord bot token
 * @param fetchFn - Injectable fetch function (defaults to global fetch)
 */
export function createDiscordClient(
  botToken: string,
  fetchFn: FetchFn = fetch,
): DiscordClient {
  /**
   * Perform an authenticated fetch against the Discord REST API.
   * Supports GET (default) and POST with arbitrary body/content-type.
   * Handles 429 rate limits with a single retry after Retry-After.
   */
  async function discordFetch(
    path: string,
    options?: { method?: string; body?: BodyInit; contentType?: string },
  ): Promise<Response> {
    const url = `${DISCORD_API_BASE}${path}`;
    const method = options?.method ?? "GET";

    const headers: Record<string, string> = {
      Authorization: `Bot ${botToken}`,
    };
    // For GET requests or when no explicit content-type, default to application/json.
    // For POST with an explicit content-type (e.g. multipart/form-data), use that instead.
    if (options?.contentType) {
      headers["Content-Type"] = options.contentType;
    } else {
      headers["Content-Type"] = "application/json";
    }

    const init: RequestInit = { method, headers };
    if (options?.body !== undefined) {
      init.body = options.body;
    }

    const res = await fetchFn(url, init);

    // Rate limit handling: respect 429 + Retry-After header
    if (res.status === 429) {
      // Consume the response body to free the connection
      await res.text();
      const rawRetryAfter = res.headers.get("Retry-After");
      const retryAfter = rawRetryAfter !== null ? Number(rawRetryAfter) : 1;
      const waitMs = Math.max(0, retryAfter) * 1000;
      console.warn(
        `[discord] 429 rate limited on ${method} ${path} — retrying after ${waitMs}ms`,
      );
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      // Retry once after waiting
      return fetchFn(url, init);
    }

    return res;
  }

  return {
    async fetchChannels(guildId: string): Promise<DiscordChannel[]> {
      const res = await discordFetch(`/guilds/${guildId}/channels`);
      if (!res.ok) {
        throw new Error(
          `Failed to fetch channels for guild ${guildId}: ${res.status} ${res.statusText}`,
        );
      }
      return res.json() as Promise<DiscordChannel[]>;
    },

    async fetchMessages(
      channelId: string,
      limit = 50,
    ): Promise<DiscordMessage[]> {
      const res = await discordFetch(
        `/channels/${channelId}/messages?limit=${limit}`,
      );
      if (!res.ok) {
        throw new Error(
          `Failed to fetch messages for channel ${channelId}: ${res.status} ${res.statusText}`,
        );
      }
      return res.json() as Promise<DiscordMessage[]>;
    },

    async sendMessage(
      channelId: string,
      body: BodyInit,
      contentType: string,
    ): Promise<SendMessageResponse> {
      const res = await discordFetch(`/channels/${channelId}/messages`, {
        method: "POST",
        body,
        contentType,
      });

      const rawText = await res.text();
      let responseBody: unknown;
      try {
        responseBody = JSON.parse(rawText);
      } catch {
        responseBody = rawText;
      }
      return {
        ok: res.ok,
        status: res.status,
        headers: res.headers,
        body: responseBody,
      };
    },
  };
}
