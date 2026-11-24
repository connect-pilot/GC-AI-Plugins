// A minimal MCP Apps host for previewing the dashboard locally (npm run dev, then npm run harness).
// Tool calls go to the local MCP server; chat messages, links and downloads are logged on the page.
import { AppBridge, PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const log = (...a) => {
  const el = document.getElementById("log");
  el.textContent = `${new Date().toLocaleTimeString()}  ${a.join(" ")}\n` + el.textContent;
};
window.__messages = [];

const client = new Client({ name: "local-host", version: "1.0.0" });
await client.connect(new StreamableHTTPClientTransport(new URL("/mcp", location.href)));
const res = await client.readResource({ uri: "ui://gc-resume-builder/v1.html" });
const iframe = document.getElementById("app");

let mode = new URLSearchParams(location.search).get("mode") ?? "fullscreen";
const ctx = () => ({ displayMode: mode, availableDisplayModes: ["inline", "fullscreen"], theme: "light" });
const bridge = new AppBridge(client, { name: "local-host", version: "1.0.0" }, { openLinks: {}, serverTools: {}, downloadFile: {}, message: {} }, { hostContext: ctx() });
bridge.onmessage = async ({ content }) => {
  const text = content.map((c) => c.text).join("\n");
  window.__messages.push(text);
  log("CHAT MESSAGE:", text);
  return {};
};
bridge.onopenlink = async ({ url }) => (log("OPEN LINK:", url), {});
bridge.ondownloadfile = async ({ contents }) => (log("DOWNLOAD:", contents.map((c) => c.resource?.uri ?? c.uri).join(", ")), {});
bridge.onrequestdisplaymode = async ({ mode: m }) => ((mode = m), bridge.setHostContext?.(ctx()), log("DISPLAY MODE:", m), { mode: m });
window.__bridge = bridge;

// Connect before the page loads: the app sends its initialize request as soon as its script runs.
await bridge.connect(new PostMessageTransport(iframe.contentWindow, iframe.contentWindow));
bridge.oninitialized = async () => {
  const build = new URLSearchParams(location.search).get("build");
  if (build) {
    await bridge.sendToolInput?.({ arguments: { build_id: build } });
    await bridge.sendToolResult({ content: [{ type: "text", text: "ok" }], structuredContent: { build_id: build } });
  }
  log("app initialized");
};
iframe.srcdoc = res.contents[0].text;
document.getElementById("inline").onclick = () => ((mode = "inline"), bridge.setHostContext?.(ctx()));
document.getElementById("full").onclick = () => ((mode = "fullscreen"), bridge.setHostContext?.(ctx()));
