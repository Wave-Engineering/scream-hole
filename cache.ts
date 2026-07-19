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
   *
   * An `after` older than the cache window is CLAMPED to the window start, so
   * everything cached is returned — it does NOT return an empty array. (That
   * was this docstring's previous claim and it described pre-clamp behavior;
   * the README now publishes the clamp as a contract, so do not "restore" the
   * empty-array behavior without changing both.)
   *
   * `limit` returns the NEWEST n matches, discarding older ones nearest the
   * `after` cursor — see the caveat in README.md's endpoint notes. Whether that
   * matches Discord's own `after`+`limit` ordering is UNMEASURED; see #30
   * before trusting the "matching Discord API behavior" note at the slice.
   */
  getMessages(
    channelId: string,
    after: string,
    limit?: number,
  ): { data: DiscordMessage[]; cachedAt: number } | undefined;

  /** Get cache statistics */
  getStats(): CacheStats;

  /**
   * Run eviction pass: drop messages older than the cache window. Empty
   * entries are KEPT for channels still discovered in Discord — so a quiet or
   * aged-out known channel returns 200 [] rather than 404 (#16). An entry is
   * removed only once it has aged out to empty AND its channel is no longer in
   * the discovered set (truly deleted). Before the first successful channel
   * poll (no discovery yet) nothing is dropped.
   */
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

      // Clamp: if `after` is older than the cache window, use the window
      // start so we return all cached messages instead of an empty result
      const afterTs = snowflakeToTimestamp(after);
      const windowStart = Date.now() - cacheWindowMs;
      const afterBigInt = afterTs < windowStart
        ? ((BigInt(windowStart) - DISCORD_EPOCH) << 22n) - 1n
        : BigInt(after);
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
      // Build the set of channel IDs currently discovered in Discord (across
      // all cached guilds). The poller re-discovers the guild every cycle, so
      // this reflects the live channel list.
      //
      // ASSUMES A SINGLE POLLED GUILD: `discovered` is global across guilds and
      // applied to every messageCache channel. That is safe only because the
      // deployment is hard-single-guild (DISCORD_GUILD_ID is a scalar, one
      // poller). If multi-guild polling with independent schedules is ever
      // added, this must be scoped per-guild — otherwise a live channel in a
      // not-yet-polled guild B would be absent from `discovered` while guild A
      // makes haveDiscovery true, and get wrongly dropped once it ages out to
      // empty. The belt-and-suspenders fix then needs a channel→guild reverse
      // map: require the channel's owning guild to have been polled this cycle
      // before dropping it.
      const discovered = new Set<string>();
      for (const entry of channelCache.values()) {
        for (const ch of entry.data) {
          discovered.add(ch.id);
        }
      }
      // Only treat the discovered set as authoritative once we actually have
      // channel data — before the first successful channel poll we cannot prove
      // anything has disappeared, so we keep every entry (cold-start safe).
      const haveDiscovery = discovered.size > 0;

      for (const [channelId, entry] of messageCache.entries()) {
        const filtered = evictMessages(entry.data);
        // Drop an entry ONLY when it has aged out to empty AND the channel is
        // no longer discovered in Discord — i.e. it was truly deleted. This
        // bounds the empty-entry leak without re-introducing the 404 bug (#16).
        if (filtered.length === 0 && haveDiscovery && !discovered.has(channelId)) {
          messageCache.delete(channelId);
        } else {
          // Keep the entry (possibly empty) so a quiet/aged-out *known* channel
          // returns 200 [] instead of 404.
          entry.data = filtered;
        }
      }
    },
  };
}
