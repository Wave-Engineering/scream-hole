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
| POST | `/api/v10/channels/{id}/messages` | Write pass-through — forwards to Discord |

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
