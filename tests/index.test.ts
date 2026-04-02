import { describe, expect, test } from "bun:test";
import { handleRequest, VERSION } from "../index";

describe("GET /health", () => {
  test("returns 200 with status ok, uptime, and version", async () => {
    const req = new Request("http://localhost/health", { method: "GET" });
    const res = handleRequest(req);

    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(typeof body.uptime).toBe("number");
    expect(body.uptime).toBeGreaterThanOrEqual(0);
    expect(body.version).toBe(VERSION);
  });
});

describe("unknown routes", () => {
  test("returns 404 for unknown path", async () => {
    const req = new Request("http://localhost/unknown", { method: "GET" });
    const res = handleRequest(req);

    expect(res.status).toBe(404);

    const body = await res.json();
    expect(body.error).toBe("not found");
  });
});
