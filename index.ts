import { loadConfig } from "./config";

const VERSION = "0.1.0";
const startTime = Date.now();

/**
 * Handle incoming HTTP requests.
 * Currently only serves the health endpoint; Discord proxy routes will be added later.
 */
function handleRequest(req: Request): Response {
  const url = new URL(req.url);

  if (req.method === "GET" && url.pathname === "/health") {
    return Response.json({
      status: "ok",
      uptime: Math.floor((Date.now() - startTime) / 1000),
      version: VERSION,
    });
  }

  return Response.json({ error: "not found" }, { status: 404 });
}

// Only start the server when run directly (not during tests importing this module)
if (import.meta.main) {
  const config = loadConfig();

  const server = Bun.serve({
    port: config.port,
    fetch: handleRequest,
  });

  console.log(`scream-hole v${VERSION} listening on port ${server.port}`);
}

export { handleRequest, VERSION };
