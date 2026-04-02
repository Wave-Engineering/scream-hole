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

export interface DiscordClient {
  fetchChannels(guildId: string): Promise<DiscordChannel[]>;
  fetchMessages(
    channelId: string,
    limit?: number,
  ): Promise<DiscordMessage[]>;
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
  async function discordFetch(path: string): Promise<Response> {
    const url = `${DISCORD_API_BASE}${path}`;
    const res = await fetchFn(url, {
      headers: {
        Authorization: `Bot ${botToken}`,
        "Content-Type": "application/json",
      },
    });

    // Rate limit handling: respect 429 + Retry-After header
    if (res.status === 429) {
      const rawRetryAfter = res.headers.get("Retry-After");
      const retryAfter = rawRetryAfter !== null ? Number(rawRetryAfter) : 1;
      const waitMs = Math.max(0, retryAfter) * 1000;
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      // Retry once after waiting
      return fetchFn(url, {
        headers: {
          Authorization: `Bot ${botToken}`,
          "Content-Type": "application/json",
        },
      });
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
  };
}
