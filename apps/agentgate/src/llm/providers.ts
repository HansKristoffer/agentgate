import * as claude from "./claude.ts";
import * as codex from "./codex.ts";
import * as cursor from "./cursor.ts";
import { capabilities } from "./provider.ts";

export const providers = { claude: claude.claude, codex: codex.codex, cursor: cursor.cursor };
export const providerLogins = { claude, codex, cursor };
export const providerCapabilities = () => ({ claude: capabilities(providers.claude), codex: capabilities(providers.codex), cursor: capabilities(providers.cursor) });
