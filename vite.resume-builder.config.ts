import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

// Builds the Resume Builder dashboard into one self-contained HTML file (served as an MCP Apps resource).
export default defineConfig({
  root: fileURLToPath(new URL("./ui/resume-builder", import.meta.url)),
  plugins: [viteSingleFile()],
  build: {
    outDir: fileURLToPath(new URL("./dist/ui/resume-builder", import.meta.url)),
    emptyOutDir: false, // dist/ also holds the compiled server
    assetsInlineLimit: 100_000_000,
  },
});
