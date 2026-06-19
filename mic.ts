/**
 * Per-channel advisory coordination leases (#14).
 *
 * Two cheap, TTL'd primitives that every agent already reaches through
 * scream-hole, to tame the "many agents answer at once" chaos:
 *
 *  - **mic**: a talking-stick. An agent claims it before answering a team
 *    question; others see it's taken and hold (keep researching, don't speak).
 *    Advisory — it serializes the *timing* of a decision the agents already make
 *    (domain ownership); it does not re-decide who should speak.
 *  - **send**: a multipart send-mutex. While one agent emits `1/3,2/3,3/3`,
 *    another's parts can't interleave on the channel.
 *
 * Both are leases with a TTL so a crashed/stalled holder auto-frees — they can
 * never deadlock. State is in-memory (scream-hole is the single shared poller).
 */

export type LeaseKind = "mic" | "send";

export interface Lease {
  holder: string;
  expiresAt: number; // epoch ms
}

export interface ClaimResult {
  granted: boolean;
  holder: string;
  expiresAt: number;
}

const leases = new Map<string, Lease>();

function key(kind: LeaseKind, channel: string): string {
  return `${kind}:${channel}`;
}

/** For tests: drop all leases. */
export function _resetLeases(): void {
  leases.clear();
}

/**
 * Claim a lease. Granted if the lease is free, expired, or already held by the
 * same holder (a re-claim refreshes the TTL). Otherwise returns the current
 * holder without changing anything.
 */
export function claim(
  kind: LeaseKind,
  channel: string,
  holder: string,
  ttlMs: number,
  now: number = Date.now(),
): ClaimResult {
  const k = key(kind, channel);
  const cur = leases.get(k);
  if (cur && cur.expiresAt > now && cur.holder !== holder) {
    return { granted: false, holder: cur.holder, expiresAt: cur.expiresAt };
  }
  const lease: Lease = { holder, expiresAt: now + ttlMs };
  leases.set(k, lease);
  return { granted: true, holder, expiresAt: lease.expiresAt };
}

/**
 * Release a lease. Succeeds (idempotently) if free/expired. Refuses if held by
 * someone else — only the holder may release.
 */
export function release(
  kind: LeaseKind,
  channel: string,
  holder: string,
  now: number = Date.now(),
): { released: boolean; holder?: string } {
  const k = key(kind, channel);
  const cur = leases.get(k);
  if (!cur || cur.expiresAt <= now) return { released: true };
  if (cur.holder !== holder) return { released: false, holder: cur.holder };
  leases.delete(k);
  return { released: true };
}

/** Current holder of a lease, or null if free/expired. */
export function status(
  kind: LeaseKind,
  channel: string,
  now: number = Date.now(),
): Lease | null {
  const cur = leases.get(key(kind, channel));
  if (!cur || cur.expiresAt <= now) return null;
  return { holder: cur.holder, expiresAt: cur.expiresAt };
}

/** Default lease TTLs (ms). Generous enough to cover a turn; short enough to self-heal. */
export const DEFAULT_TTL: Record<LeaseKind, number> = {
  mic: 90_000,
  send: 30_000,
};
