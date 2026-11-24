import type { GcPlugin } from "../core/plugin.js";
import { gmailPlugin } from "./gmail/index.js";
import { pingPlugin } from "./ping/index.js";
import { resumeBuilderPlugin } from "./resume-builder/index.js";

// Registry: to add a plugin, create src/plugins/<id>/index.ts and add it here.
export const allPlugins: GcPlugin[] = [pingPlugin, resumeBuilderPlugin, gmailPlugin];

export function selectPlugins(enabled: string[] | null, plugins: GcPlugin[] = allPlugins): GcPlugin[] {
  if (!enabled) return plugins;
  const unknown = enabled.filter((id) => !plugins.some((p) => p.id === id));
  if (unknown.length) throw new Error(`Unknown plugin id(s) in ENABLED_PLUGINS: ${unknown.join(", ")}`);
  return plugins.filter((p) => enabled.includes(p.id));
}
