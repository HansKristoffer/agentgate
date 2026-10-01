// @ts-check
import { defineConfig } from "astro/config";

// Static output for Cloudflare Pages. The page reads the latest release at
// build time, so a new version needs a rebuild rather than an edit.
export default defineConfig({ site: "https://agentgate.pages.dev" });
