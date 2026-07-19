# scream-hole

Discord REST API caching proxy — polls Discord once, caches responses, serves them to multiple consumers.

## Quick Start

### Docker

```bash
docker run -d \
  -e DISCORD_BOT_TOKEN=your-token \
  -e DISCORD_GUILD_ID=your-guild-id \
  -p 3000:3000 \
  ghcr.io/wave-engineering/scream-hole:latest
```

### Docker Compose (local dev)

Create a `.env` file:

```env
DISCORD_BOT_TOKEN=your-token
DISCORD_GUILD_ID=your-guild-id
```

```bash
docker compose up
```

### Bun (direct)

```bash
bun install
DISCORD_BOT_TOKEN=your-token DISCORD_GUILD_ID=your-guild-id bun run start
```

## Configuration

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DISCORD_BOT_TOKEN` | Yes | — | Discord bot token (or `~/secrets/discord-bot-token`) |
| `DISCORD_GUILD_ID` | Yes | — | Discord server ID to proxy |
| `POLL_INTERVAL_MS` | No | `15000` | How often to poll Discord (ms) |
| `CACHE_WINDOW_MS` | No | `14400000` | Cache window — messages older than this are evicted (default 4h) |
| `PORT` | No | `3000` | HTTP server port |
| `LOG_LEVEL` | No | `info` | Log level: debug, info, warn, error |

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check — status, uptime, version, cache stats |
| GET | `/api/v10/guilds/{id}/channels` | Cached channel list |
| GET | `/api/v10/channels/{id}/messages?after=SNOWFLAKE` | Cached messages (`after` required) |
| GET | `/api/v10/channels/{id}/messages/{messageId}` | Single message — **live**, never cached (see below) |
| POST | `/api/v10/channels/{id}/messages` | Write pass-through — forwards to Discord |

The messages endpoint **fails open**: a quiet, idle, or not-yet-cached channel
returns `200 []` (never 404), so consumers treat it as "nothing new" instead of
falling back to Discord directly and storming its rate limit. Any `after` value
is accepted, including `after=0` ("everything cached").

Single-message fetch is deliberately **not** cache-backed. Callers use it to tell
a deleted message from a transient failure, and a cache cannot represent a
deletion it has not yet polled — so a cached hit would report a message deleted
upstream as still present, inverting exactly the distinction the caller is
making. It forwards live to Discord and returns Discord's status and body
verbatim, including a genuine `404 {"message":"Unknown Message","code":10008}`.

### Unrouted paths return 501, not 404

A path this proxy does not serve returns:

```json
501 { "error": "no route for this path", "proxy": "scream-hole" }
```

**Do not use 404 to mean "the proxy has no such route."** Because scream-hole
fronts Discord's API surface, a 404 from the proxy is indistinguishable from
Discord's own `{"message":"Unknown Message","code":10008}`, and consumers read
that as *the resource was deleted*. That ambiguity silently dropped forwarded
messages for days — a missing route and a deleted message returned
byte-comparable answers.

### Who answered? Every proxy-originated error carries `proxy`

The rule is broader than the catch-all. **Every error this proxy constructs
itself** — 400s on bad parameters, the 503s when no Discord client is
configured, the uncached-guild 404, the lease 400/405s, the 501 catch-all —
carries `proxy: "scream-hole"`. A response **forwarded from Discord** never
does; those pass through byte-for-byte.

The general invariant, covering successes too:

> **Every response scream-hole constructs on the Discord-impersonating surface
> carries a positive origin marker** — `proxy` in the body for errors, `X-Cache`
> in the headers for cache-backed reads. **Responses forwarded from Discord carry
> neither.**

The header half is not redundant: a cache read returns a bare Discord-shaped
JSON array, which has nowhere to put a key, so body-stamping cannot cover the
success side at all.

| Response carries | Answered by | Meaning |
|---|---|---|
| `proxy: "scream-hole"` in body | this proxy | says nothing about the origin resource |
| `X-Cache` header | this proxy, from cache | our view, possibly stale |
| numeric `code` in body | Discord | authoritative about the resource |
| neither marker | something else in the path | treat as transient, never as deletion |

**Failures distinguish whose fault they were**, which matters because the two
call for opposite responses:

| Status | Means | Retry? |
|---|---|---|
| `502 {"error": "upstream Discord request failed", "proxy": …}` | we tried to reach Discord and could not | **yes** — transient by nature |
| `500 {"error": "proxy failed to handle this request", "proxy": …}` | a fault inside this proxy; Discord may never have been contacted | **no** — retrying a deterministic bug just hides it |

The 502 is raised only around the call that actually contacts Discord, never
around surrounding logic. A proxy that blames the origin for its own faults is
the same mislabeling this whole contract exists to prevent, just pointed the
other way.

**Scope of the markers.** `/health` and `/lease/*` **successes** are unmarked:
Discord serves neither path, so provenance is never in question and stamping
them would dilute what the marker means. Their **errors** are marked like every
other error — the exemption covers successful responses only, and an error is
where the ambiguity would actually cost something.

Identify a proxy answer by the **presence of `proxy`**, never by the absence of
Discord's `code`. Absence-based checks flip silently the first time either body
grows a field, and stay wrong without failing any test.

This is enforced in code rather than by convention: proxy-originated errors are
built by a single `proxyError()` helper that stamps the key, so a route added
later cannot forget to opt in. That is deliberate — the original outage happened
because one unrouted path produced a body indistinguishable from Discord's.

## Development

```bash
bun install
bun test
bun run lint
```

## Architecture

```
Consumer A ──┐
Consumer B ──┤──▶ scream-hole ──(poll)──▶ Discord REST API
Consumer C ──┘       │
                   cache
```

Single poller fetches channels and messages on a configurable interval. Consumers read from the cache via Discord-compatible REST endpoints. Writes are forwarded to Discord and injected into the cache immediately.

## License

MIT
