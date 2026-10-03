import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { safePath } from "@agentgate/protocol";
import type { Store } from "../store.ts";
import type { Source } from "./gateway.ts";

const PAGE = 100;
const DESCRIPTION = 1024;
const CHUNK = 128 * 1024; // characters per read
const LISTED_FILES = 500;

const text = (value: string): CallToolResult => ({ content: [{ type: "text", text: value }] });
const fail = (value: string): CallToolResult => ({ isError: true, content: [{ type: "text", text: value }] });

/** Skill ids a project may read right now; read on every call, so an unassigned skill stops working mid-session. */
function assigned(s: Store, project: string): string[] {
  const p = s.get("project", project);
  const ids = new Set([...(p?.skills ?? []), ...(p?.inheritDefaults ? s.get("project", "*")?.skills ?? [] : [])]);
  return [...ids].filter(id => s.get("skill", id)).sort();
}

/** Skills for clients that can't install them (Grok): list them, then read SKILL.md and the files it references. */
export function skillsServer(s: Store, project: string): Server {
  const server = new Server({ name: "agentgate-skills", version: "1" }, {
    capabilities: { tools: {} },
    instructions: "This server has skills: instructions for specific tasks. Call skills__list, then skills__read a relevant skill's SKILL.md and follow it. Read the files it references with skills__read.",
  });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "list", description: "List the skills available to you, with what each one is for.",
        inputSchema: { type: "object", properties: { cursor: { type: "string", description: "nextCursor from the previous page" } } },
      },
      {
        name: "read", description: "Read a file of a skill. Start with SKILL.md; it lists the skill's other files.",
        inputSchema: {
          type: "object", required: ["id"],
          properties: {
            id: { type: "string", description: "Skill id from list" },
            path: { type: "string", description: "File inside the skill, default SKILL.md" },
            offset: { type: "number", description: "nextOffset from a previous read of a long file" },
          },
        },
      },
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    const ids = assigned(s, project);
    if (req.params.name === "list") {
      const start = Number(args.cursor ?? 0);
      if (!Number.isInteger(start) || start < 0) return fail("invalid cursor");
      const page = ids.slice(start, start + PAGE).map(id => ({ id, description: (s.get("skill", id)?.description ?? "").slice(0, DESCRIPTION) }));
      return text(JSON.stringify({ skills: page, ...(start + PAGE < ids.length && { nextCursor: String(start + PAGE) }) }));
    }
    if (req.params.name !== "read") return fail(`unknown tool ${req.params.name}`);
    const id = String(args.id ?? ""), path = String(args.path ?? "SKILL.md"), offset = Number(args.offset ?? 0);
    if (!ids.includes(id)) return fail(`no skill ${id}`);
    if (!safePath(path)) return fail("invalid path");
    if (!Number.isInteger(offset) || offset < 0) return fail("invalid offset");
    const skill = s.get("skill", id)!;
    const file = skill.files.find(f => f.path === path);
    if (!file) return fail(`${id} has no file ${path}`);
    let content: string;
    try { content = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(file.data, "base64")); }
    catch { return fail(`${path} is a binary file and can't be read as text`); }
    let out = content.slice(offset, offset + CHUNK);
    if (offset + CHUNK < content.length) out += `\n\n[truncated: call skills__read again with offset ${offset + CHUNK}]`;
    if (path === "SKILL.md" && offset === 0 && skill.files.length > 1) {
      const files = skill.files.map(f => f.path).filter(p => p !== "SKILL.md");
      out += `\n\n---\nFiles in this skill (read with skills__read):\n${files.slice(0, LISTED_FILES).join("\n")}${files.length > LISTED_FILES ? `\n… and ${files.length - LISTED_FILES} more` : ""}`;
    }
    return text(out);
  });
  return server;
}

/** The skill tools as a gateway source under the `skills` alias. */
export async function skillsSource(s: Store, project: string): Promise<Source> {
  const [a, b] = InMemoryTransport.createLinkedPair();
  const server = skillsServer(s, project), client = new Client({ name: "agentgate", version: "1" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const close = client.close.bind(client);
  client.close = async () => { await close(); await server.close(); };
  return { alias: "skills", client };
}
