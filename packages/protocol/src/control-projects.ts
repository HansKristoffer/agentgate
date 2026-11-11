import type { ToolPreview } from "./index.ts";

type Endpoint = { url: string; secret: string };
/** The checkout a file command runs in on the daemon's machine, or the project when the caller has none. */
type FilesTarget = { project: string } | { cwd: string };

/** The projects family's control operations the app calls, by name (see control.ts). */
export interface ProjectOps {
  /** Creates or changes a project. `mcp` maps the tool prefixes to change; null removes one. With `revision`, a project
   * another machine changed since is refused. */
  "project set": {
    input: {
      id: string;
      mcp?: Record<string, string | null>;
      skills?: string[];
      inheritDefaults?: boolean;
      revision?: string;
    };
    result: { id: string; revision: string };
  };
  "project rm": { input: { id: string }; result: { id: string } };
  "project mirroring": { input: { project: string; on: boolean }; result: { checkouts: string[] } };
  "project scan": { input: { dir: string }; result: { repos: { repo: string; path: string }[] } };
  "project tools": { input: { id: string }; result: ToolPreview[] };
  "project files add": { input: FilesTarget & { paths: string[] }; result: { project: string } };
  "project files rm": { input: FilesTarget & { paths: string[] }; result: { project: string } };
  "project files set": {
    input: FilesTarget & { path: string; content: string; sha256?: string };
    result: { project: string; checkouts: Record<string, number> };
  };
  "remote enable": { input: { id: string; servedBy?: string }; result: Endpoint };
  "remote secret": { input: { id: string }; result: Endpoint };
  "remote regenerate": { input: { id: string }; result: Endpoint };
  "remote disable": { input: { id: string }; result: { id: string } };
  "remote factory": { input: { id: string; on: boolean }; result: { id: string; on: boolean } };
  "remote webhook": { input: { id: string; url: string | null }; result: { id: string; on: boolean } };
}
