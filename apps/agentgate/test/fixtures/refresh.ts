import { Credentials } from "../../src/credentials.ts";
import { CLAUDE, claude } from "../../src/llm/claude.ts";
import { Store } from "../../src/store.ts";
CLAUDE.tokenUrl = Bun.argv[3]!;
const s = new Store(Bun.argv[2]!);
try { const credential = await new Credentials(s, (_, rt) => claude.refresh(rt), async () => { }).refresh("a"); console.log(credential.accessToken); }
finally { s.close(); }
