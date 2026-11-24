import { z } from "zod";
import type { GcPlugin } from "../../core/plugin.js";

export const pingPlugin: GcPlugin = {
  id: "ping",
  name: "Connection check",
  description: "Confirms the GoldCoast MCP server is reachable and shows who is signed in.",
  register(server, ctx) {
    server.registerTool(
      "ping_whoami",
      {
        title: "Check GoldCoast connection",
        description: "Use when the user asks to test or check the GoldCoast tools connection. Returns the signed-in email and server time.",
        inputSchema: { echo: z.string().max(200).optional().describe("Optional text to echo back") },
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      async ({ echo }) => {
        const result = { ok: true, user: ctx.user.email, serverTime: new Date().toISOString(), echo };
        return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
      },
    );
  },
};
