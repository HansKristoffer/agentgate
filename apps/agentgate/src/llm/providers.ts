import * as claude from "./claude.ts";
import * as codex from "./codex.ts";
import { capabilities } from "./provider.ts";

export const providers = { claude: claude.claude, codex: codex.codex };
export const providerLogins = { claude, codex };
export const providerCapabilities = () => ({ claude: capabilities(providers.claude), codex: capabilities(providers.codex) });
