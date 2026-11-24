import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// Local MCP Apps host for previewing the dashboard: proxies /mcp and /resume to the dev server.
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  server: { port: 5199, proxy: { "/mcp": "http://localhost:8787", "/resume": "http://localhost:8787" } },
});
