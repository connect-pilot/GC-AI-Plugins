// MCP Apps bridge for the GoldCoast Resume Builder: every server call goes through the host
// (Claude, ChatGPT) with app.callServerTool. Credentials stay on the server.
import { App } from "@modelcontextprotocol/ext-apps";
import { installLauncher } from "../shared/launcher.js";
import logo from "./gc-logo.png";

export const LOGO = logo;
const app = new App({ name: "GoldCoast Resume Builder", version: "1.0.0" }, {});

// Tool results that open the dashboard (resume_open_builder / resume_generate) can name a build.
const resultListeners = [];
let lastResult = null;
export function onToolResult(cb) {
  resultListeners.push(cb);
  if (lastResult) cb(lastResult);
}
app.ontoolresult = (params) => {
  lastResult = params?.structuredContent ?? null;
  if (lastResult) resultListeners.forEach((cb) => cb(lastResult));
};

let launcher = { update() {}, setCard() {} };
app.onhostcontextchanged = () => launcher.update();
const ready = app.connect();
launcher = installLauncher(app, ready, {
  title: "GoldCoast Resume Builder",
  subtitle: "Turn a candidate's resume into a branded presentation resume and client email.",
  logo,
});
export const setLauncherCard = (c) => launcher.setCard(c);

function textOf(result) {
  return (result?.content ?? [])
    .filter((p) => p?.type === "text" && typeof p.text === "string")
    .map((p) => p.text)
    .join("\n")
    .trim();
}

/** Calls a server tool. Resolves { status, ...data } and never throws for tool errors (only for host failures). */
export async function call(tool, args = {}) {
  await ready;
  const result = await app.callServerTool({ name: tool, arguments: args });
  let data = result?.structuredContent ?? null;
  if (!data) {
    try {
      data = JSON.parse(textOf(result));
    } catch {
      data = null;
    }
  }
  if (result?.isError) {
    const text = textOf(result);
    return {
      ...(data && typeof data === "object" ? data : {}),
      status: typeof data?.status === "string" ? data.status : "error",
      message: (typeof data?.message === "string" && data.message) || (text && !text.startsWith("{") ? text : "") || "The Resume Builder couldn't complete that.",
    };
  }
  if (data && typeof data.status === "string") return data;
  return { status: "success", ...(data ?? {}) };
}

/** Posts a user message into the chat so Claude acts on it. Resolves false if the host can't. */
export async function sendToChat(text) {
  try {
    await ready;
    const r = await app.sendMessage({ role: "user", content: [{ type: "text", text }] });
    return !r?.isError;
  } catch {
    return false;
  }
}

/** Opens a link in the user's browser through the host. */
export async function openLink(url) {
  try {
    await ready;
    const r = await app.openLink({ url });
    return !r?.isError;
  } catch {
    return false;
  }
}

/** Saves a file through the host (sandboxed iframes can't download), falling back to opening its link. */
export async function download({ file_name, mime_type, data_base64, url }) {
  try {
    await ready;
    if (typeof app.downloadFile === "function") {
      const r = await app.downloadFile({ contents: [{ type: "resource", resource: { uri: `file:///${encodeURIComponent(file_name)}`, mimeType: mime_type, blob: data_base64 } }] });
      if (!r?.isError) return true;
    }
  } catch {
    // fall back to the signed link
  }
  return url ? openLink(url) : false;
}

export async function requestFullscreen() {
  try {
    await ready;
    await app.requestDisplayMode({ mode: "fullscreen" });
  } catch {
    // stays inline
  }
}
