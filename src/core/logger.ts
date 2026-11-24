// Metadata-only logger. Never pass prompts, tool arguments or tool results here —
// the server is stateless and conversation data stays inside the AI app.
export type LogFields = Record<string, string | number | boolean | undefined>;

export interface Logger {
  info(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
}

export const logger: Logger = {
  info: (msg, fields) => console.log(JSON.stringify({ level: "info", msg, ...fields, ts: new Date().toISOString() })),
  error: (msg, fields) => console.error(JSON.stringify({ level: "error", msg, ...fields, ts: new Date().toISOString() })),
};
