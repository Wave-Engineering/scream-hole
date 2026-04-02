import { describe, expect, test } from "bun:test";
import { loadConfig } from "../config";

describe("loadConfig", () => {
  const requiredEnv = {
    DISCORD_BOT_TOKEN: "test-token-123",
    DISCORD_GUILD_ID: "guild-456",
  };

  test("loads with correct defaults when only required vars set", () => {
    const config = loadConfig(requiredEnv);

    expect(config.discordBotToken).toBe("test-token-123");
    expect(config.discordGuildId).toBe("guild-456");
    expect(config.pollIntervalMs).toBe(15000);
    expect(config.port).toBe(3000);
    expect(config.logLevel).toBe("info");
  });

  test("env vars override defaults", () => {
    const config = loadConfig({
      ...requiredEnv,
      POLL_INTERVAL_MS: "5000",
      PORT: "8080",
      LOG_LEVEL: "debug",
    });

    expect(config.pollIntervalMs).toBe(5000);
    expect(config.port).toBe(8080);
    expect(config.logLevel).toBe("debug");
  });

  test("throws when DISCORD_BOT_TOKEN is missing", () => {
    expect(() => loadConfig({ DISCORD_GUILD_ID: "guild-456" })).toThrow(
      "DISCORD_BOT_TOKEN is required",
    );
  });

  test("throws when DISCORD_GUILD_ID is missing", () => {
    expect(() =>
      loadConfig({ DISCORD_BOT_TOKEN: "test-token" }),
    ).toThrow("DISCORD_GUILD_ID is required");
  });

  test("falls back to info for invalid log level", () => {
    const config = loadConfig({
      ...requiredEnv,
      LOG_LEVEL: "invalid",
    });
    expect(config.logLevel).toBe("info");
  });
});
