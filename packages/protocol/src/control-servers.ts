import type { ProjectChange, ToolPreview } from "./index.ts";

/** How a server is offered to agents where it differs from the default. A missing key is the default. */
export interface ServerTuning {
  id: string;
  /** Only these tools are offered; absent offers every tool. */
  tools?: string[];
  /** Replaces the server's own instructions; empty hides them. */
  instructions?: string;
  /** Results past this many characters are cut; 0 never cuts. */
  maxResultChars?: number;
  toolOptions?: Record<string, { maxResultChars?: number; defaults?: Record<string, unknown> }>;
}

/** The MCP servers family's control operations the app calls, by name (see control.ts). */
export interface ServerOps {
  "mcp add": {
    input: { name: string; target?: string; command?: string; perSession?: boolean; headers?: string };
    result: { id: string; needsLogin: boolean };
  };
  "mcp rm": { input: { id: string }; result: { id: string } };
  "mcp label": { input: { id: string; label: string }; result: { id: string } };
  "mcp rename": { input: { id: string; to: string }; result: { id: string } };
  "mcp projects": { input: { id: string } & ProjectChange; result: { projects: string[] } };
  "mcp tools": { input: { id: string; tools?: string[] }; result: ServerTuning };
  "mcp instructions": { input: { id: string; instructions?: string }; result: ServerTuning };
  /** Without `tool`, the server's limit; without `chars`, back to the default. */
  "mcp limit": { input: { id: string; tool?: string; chars?: number }; result: ServerTuning };
  "mcp defaults": { input: { id: string; tool: string; defaults?: Record<string, unknown> }; result: ServerTuning };
  /** The server's tools, listed over the daemon's shared connection, and how it is offered. */
  "mcp test": { input: { id: string }; result: { tools: ToolPreview[]; tuning: ServerTuning } };
}
