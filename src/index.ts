import { loadEnv } from "./core/env.js";
import { logger } from "./core/logger.js";
import { selectPlugins } from "./plugins/index.js";
import { createApp } from "./server.js";

const env = loadEnv();
const plugins = selectPlugins(env.enabledPlugins);

const missing = plugins.flatMap((p) => (p.requiredEnv ?? []).filter((k) => !env.raw[k]).map((k) => `${p.id}:${k}`));
if (missing.length) {
  throw new Error(`Missing required env vars for enabled plugins: ${missing.join(", ")}`);
}

for (const p of plugins) await p.init?.(env, logger);

const httpServer = createApp(env, plugins).listen(env.port, () => {
  logger.info("server_started", {
    port: env.port,
    plugins: plugins.map((p) => p.id).join(","),
    authDisabled: env.authDisabled,
  });
});

httpServer.on("error", (err: NodeJS.ErrnoException) => {
  logger.error("server_listen_failed", { port: env.port, code: err.code });
  process.exit(1);
});
