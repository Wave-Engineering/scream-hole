import { describe, expect, test } from "bun:test";
import { createDiscordClient } from "../discord";
import type {
  FetchFn,
  DiscordMessage,
  SendMessageResponse,
} from "../discord";

/**
 * Helper: build a fake Discord message response.
 */
function fakeMessage(
  channelId: string,
  content: string,
  id = "msg-new-1",
): DiscordMessage {
  return {
    id,
    channel_id: channelId,
    content,
    timestamp: new Date().toISOString(),
    author: { id: "u-1", username: "bot" },
  };
}

describe("sendMessage — POST proxied to Discord", () => {
  test("forwards POST body and content-type to Discord", async () => {
    let capturedUrl = "";
    let capturedMethod = "";
    let capturedBody = "";
    let capturedContentType = "";

    const responseMsg = fakeMessage("ch-1", "hello world");

    const fakeFetch: FetchFn = async (input, init) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      capturedUrl = url;
      capturedMethod = init?.method ?? "GET";
      capturedContentType =
        new Headers(init?.headers ?? {}).get("Content-Type") ?? "";
      // Read the body from the request init
      if (init?.body instanceof ArrayBuffer) {
        capturedBody = new TextDecoder().decode(init.body);
      } else if (typeof init?.body === "string") {
        capturedBody = init.body;
      }

      return new Response(JSON.stringify(responseMsg), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    const client = createDiscordClient("test-token", fakeFetch);
    const body = JSON.stringify({ content: "hello world" });
    const result = await client.sendMessage(
      "ch-1",
      body,
      "application/json",
    );

    expect(capturedUrl).toContain("/channels/ch-1/messages");
    expect(capturedMethod).toBe("POST");
    expect(capturedContentType).toBe("application/json");
    expect(capturedBody).toBe(body);
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
  });

  test("returns Discord's response verbatim", async () => {
    const responseMsg = fakeMessage("ch-1", "response content", "msg-42");

    const fakeFetch: FetchFn = async () => {
      return new Response(JSON.stringify(responseMsg), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    const client = createDiscordClient("test-token", fakeFetch);
    const result = await client.sendMessage(
      "ch-1",
      JSON.stringify({ content: "test" }),
      "application/json",
    );

    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    const body = result.body as DiscordMessage;
    expect(body.id).toBe("msg-42");
    expect(body.content).toBe("response content");
    expect(body.channel_id).toBe("ch-1");
  });

  test("returns non-ok response from Discord without throwing", async () => {
    const fakeFetch: FetchFn = async () => {
      return new Response(
        JSON.stringify({ message: "Missing Permissions", code: 50013 }),
        {
          status: 403,
          statusText: "Forbidden",
          headers: { "Content-Type": "application/json" },
        },
      );
    };

    const client = createDiscordClient("test-token", fakeFetch);
    const result = await client.sendMessage(
      "ch-1",
      JSON.stringify({ content: "test" }),
      "application/json",
    );

    expect(result.ok).toBe(false);
    expect(result.status).toBe(403);
    const body = result.body as { message: string; code: number };
    expect(body.message).toBe("Missing Permissions");
  });

  test("forwards multipart/form-data body without modification", async () => {
    let capturedContentType = "";
    let capturedBodyText = "";

    const responseMsg = fakeMessage("ch-1", "file uploaded");

    const fakeFetch: FetchFn = async (_input, init) => {
      capturedContentType =
        new Headers(init?.headers ?? {}).get("Content-Type") ?? "";
      if (init?.body instanceof ArrayBuffer) {
        capturedBodyText = new TextDecoder().decode(init.body);
      } else if (typeof init?.body === "string") {
        capturedBodyText = init.body;
      }

      return new Response(JSON.stringify(responseMsg), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    const client = createDiscordClient("test-token", fakeFetch);

    // Simulate multipart body as raw bytes
    const multipartBoundary = "----boundary123";
    const multipartBody =
      `--${multipartBoundary}\r\n` +
      `Content-Disposition: form-data; name="content"\r\n\r\n` +
      `file uploaded\r\n` +
      `--${multipartBoundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="test.txt"\r\n` +
      `Content-Type: text/plain\r\n\r\n` +
      `file contents here\r\n` +
      `--${multipartBoundary}--`;

    const contentType = `multipart/form-data; boundary=${multipartBoundary}`;
    const result = await client.sendMessage(
      "ch-1",
      multipartBody,
      contentType,
    );

    expect(capturedContentType).toBe(contentType);
    expect(result.ok).toBe(true);
    // Verify the body was forwarded without modification
    expect(capturedBodyText).toContain("file contents here");
    expect(capturedBodyText).toContain(multipartBoundary);
  });

  test("retries on 429 rate limit for POST requests", async () => {
    let callCount = 0;
    const responseMsg = fakeMessage("ch-1", "after retry");

    const fakeFetch: FetchFn = async () => {
      callCount++;
      if (callCount === 1) {
        return new Response(
          JSON.stringify({ message: "Rate limited" }),
          {
            status: 429,
            headers: {
              "Retry-After": "0.01",
              "Content-Type": "application/json",
            },
          },
        );
      }
      return new Response(JSON.stringify(responseMsg), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    const client = createDiscordClient("test-token", fakeFetch);
    const result = await client.sendMessage(
      "ch-1",
      JSON.stringify({ content: "test" }),
      "application/json",
    );

    expect(callCount).toBe(2);
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    const body = result.body as DiscordMessage;
    expect(body.content).toBe("after retry");
  });
});
