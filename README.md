# scream-hole

Discord REST API caching proxy — polls Discord once, caches responses, serves them to multiple consumers.

## Quick Start

```bash
# Run with Bun
DISCORD_BOT_TOKEN=your-token DISCORD_GUILD_ID=your-guild-id bun run start

# Run with Docker
docker build -t scream-hole .
docker run -e DISCORD_BOT_TOKEN=your-token -e DISCORD_GUILD_ID=your-guild-id -p 3000:3000 scream-hole
```

## Configuration

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DISCORD_BOT_TOKEN` | Yes | — | Discord bot token (or `~/secrets/discord-bot-token`) |
| `DISCORD_GUILD_ID` | Yes | — | Discord server ID to proxy |
| `POLL_INTERVAL_MS` | No | `15000` | How often to poll Discord (ms) |
| `PORT` | No | `3000` | HTTP server port |
| `LOG_LEVEL` | No | `info` | Log level: debug, info, warn, error |

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check — returns status, uptime, version |

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

## License

MIT
