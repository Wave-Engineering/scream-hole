/**
 * In-memory cache for Discord API responses.
 *
 * - Messages keyed by channel ID, channels keyed by guild ID
 * - Rolling window eviction: messages older than cacheWindowMs are evicted
 * - TTL-based staleness for cache hit/miss reporting
 * - `after` filtering via snowflake ID comparison
 */

import type { DiscordChannel, DiscordMessage } from "./discord";

export interface CacheStats {
  channelsCached: number;
  totalMessages: number;
  hits: number;
  misses: number;
}

interface CacheEntry<T> {
  data: T;
  cachedAt: number;
}

/**
 * Discord snowflake IDs encode a timestamp. Extract the timestamp (ms since epoch)
 * from a snowflake string. Discord epoch is 2015-01-01T00:00:00.000Z.
 */
const DISCORD_EPOCH = 1420070400000n;

export function snowflakeToTimestamp(snowflake: string): number {
  const id = BigInt(snowflake);
  return Number((id >> 22n) + DISCORD_EPOCH);
}

export interface Cache {
  /** Store channels for a guild */
  setChannels(guildId: string, channels: DiscordChannel[]): void;
  /** Get channels for a guild. Returns undefined on miss. */
  getChannels(guildId: string): { data: DiscordChannel[]; cachedAt: number } | undefined;

  /** Store messages for a channel, evicting those older than the cache window */
  setMessages(channelId: string, messages: DiscordMessage[]): void;
  /**
   * Get messages for a channel filtered by `after` snowflake.
   * Returns undefined if the channel is not cached at all.
   * Returns empty array if `after` is older than the cache window.
   */
  getMessages(
    channelId: string,
    after: string,
    limit?: number,
  ): { data: DiscordMessage[]; cachedAt: number } | undefined;

  /** Get cache statistics */
  getStats(): CacheStats;

  /** Run eviction pass — remove messages older than the cache window */
  evict(): void;
}

export function createCache(cacheTtlMs: number, cacheWindowMs: number): Cache {
  const channelCache = new Map<string, CacheEntry<DiscordChannel[]>>();
  const messageCache = new Map<string, CacheEntry<DiscordMessage[]>>();
  let hits = 0;
  let misses = 0;

  function evictMessages(messages: DiscordMessage[]): DiscordMessage[] {
    const cutoff = Date.now() - cacheWindowMs;
    return messages.filter((msg) => {
      const ts = snowflakeToTimestamp(msg.id);
      return ts >= cutoff;
    });
  }

  return {
    setChannels(guildId: string, channels: DiscordChannel[]): void {
      channelCache.set(guildId, { data: channels, cachedAt: Date.now() });
    },

    getChannels(
      guildId: string,
    ): { data: DiscordChannel[]; cachedAt: number } | undefined {
      const entry = channelCache.get(guildId);
      if (!entry) {
        misses++;
        return undefined;
      }
      const age = Date.now() - entry.cachedAt;
      if (age > cacheTtlMs) {
        misses++;
      } else {
        hits++;
      }
      return { data: entry.data, cachedAt: entry.cachedAt };
    },

    setMessages(channelId: string, messages: DiscordMessage[]): void {
      const existing = messageCache.get(channelId);
      let merged: DiscordMessage[];

      if (existing) {
        // Merge: new messages take priority, deduplicate by ID
        const byId = new Map<string, DiscordMessage>();
        for (const msg of existing.data) {
          byId.set(msg.id, msg);
        }
        for (const msg of messages) {
          byId.set(msg.id, msg);
        }
        merged = Array.from(byId.values());
      } else {
        merged = [...messages];
      }

      // Evict old messages and sort ascending by ID (snowflake order)
      merged = evictMessages(merged);
      merged.sort((a, b) => {
        if (a.id === b.id) return 0;
        return BigInt(a.id) < BigInt(b.id) ? -1 : 1;
      });

      messageCache.set(channelId, { data: merged, cachedAt: Date.now() });
    },

    getMessages(
      channelId: string,
      after: string,
      limit?: number,
    ): { data: DiscordMessage[]; cachedAt: number } | undefined {
      const entry = messageCache.get(channelId);
      if (!entry) {
        misses++;
        return undefined;
      }

      const age = Date.now() - entry.cachedAt;
      if (age > cacheTtlMs) {
        misses++;
      } else {
        hits++;
      }

      // If `after` points to a message older than the cache window, return []
      const afterTs = snowflakeToTimestamp(after);
      const windowStart = Date.now() - cacheWindowMs;
      if (afterTs < windowStart) {
        return { data: [], cachedAt: entry.cachedAt };
      }

      // Filter to only messages with snowflake ID > after
      const afterBigInt = BigInt(after);
      let filtered = entry.data.filter((msg) => BigInt(msg.id) > afterBigInt);

      // Apply limit (return newest N, matching Discord API behavior)
      if (limit !== undefined && limit > 0 && filtered.length > limit) {
        filtered = filtered.slice(filtered.length - limit);
      }

      return { data: filtered, cachedAt: entry.cachedAt };
    },

    getStats(): CacheStats {
      let totalMessages = 0;
      for (const entry of messageCache.values()) {
        totalMessages += entry.data.length;
      }
      return {
        channelsCached: channelCache.size,
        totalMessages,
        hits,
        misses,
      };
    },

    evict(): void {
      for (const [channelId, entry] of messageCache.entries()) {
        const filtered = evictMessages(entry.data);
        if (filtered.length === 0) {
          messageCache.delete(channelId);
        } else {
          entry.data = filtered;
        }
      }
    },
  };
}
