import type { ProjectChange, SkillPreviewResponse, SkillRepoSummary } from "./index.ts";

/** The skills family's control operations the app calls, by name (see control.ts). */
export interface SkillOps {
  /** Fetches a source and holds what it found for ten minutes under `token`, for `skills add` to install. */
  "skills preview": { input: { source: string; skill?: string }; result: SkillPreviewResponse };
  "skills add": { input: { token: string; ids: string[]; projects?: string[] }; result: { installed: string[] } };
  "skills new": { input: { id: string; skillMd: string }; result: null };
  /** `revision` is the one the editor opened; a newer one refuses the save. */
  "skills edit": { input: { id: string; skillMd: string; revision?: string }; result: null };
  "skills rm": { input: { id: string }; result: null };
  /** The result is where the skill is linked afterwards. */
  "skills projects": { input: { id: string; change: ProjectChange }; result: { projects: string[] } };
  /** One skill by `id`; without it every skill installed from a source, then every connected repository. */
  "skills update": { input: { id?: string }; result: { name: string; outcome: string }[] };
  "skills repo add": { input: { url: string; projects: string[] }; result: SkillRepoSummary };
  /** One repository by `url`, or every connected one. */
  "skills repo sync": { input: { url?: string }; result: { name: string; outcome: string }[] };
  /** Never empties the set: disconnecting is `skills repo rm`. */
  "skills repo projects": { input: { url: string; change: ProjectChange }; result: { projects: string[] } };
  "skills repo rm": { input: { url: string }; result: null };
  /** A skill folder in a checkout on this machine that clashes with agentgate's copy: link ours, or keep it. */
  "skills resolve": { input: { path: string; use: "agentgate" | "keep" }; result: { backup?: string } };
}
