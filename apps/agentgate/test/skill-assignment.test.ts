import { expect, test } from "bun:test";
import { projectChangeSchema } from "@agentgate/protocol";
import { projectSkillChoices, repoClashes } from "../../desktop/src/skill-assignment.ts";
import { changeServerProjects, changeSkillProjects, createInstance } from "../src/operations.ts";
import { writeSkillMd } from "../src/skills.ts";
import { Store, type Project } from "../src/store.ts";

test("derived availability preserves explicit assignments across global and checkout changes", () => {
  const data = {
    skills: [{ id: "x", description: "x", updatedAt: 1, size: 1 }],
    projects: [{ id: "*", mcp: {}, skills: ["x"], skillRepos: [], inheritDefaults: true }],
    checkouts: [{ path: "/repo", project: "Owner/Repo", skills: ["x"], mirror: false }],
  };
  const choices = projectSkillChoices(data, "owner/repo", ["x"]);
  expect(choices).toHaveLength(1);
  expect(choices[0]!.selected).toBe(true);
  expect(choices[0]!.detail).toContain("every session");
  expect(choices[0]!.detail).toContain("local repository");
  data.projects[0]!.skills = [];
  data.checkouts = [];
  expect(projectSkillChoices(data, "owner/repo", ["x"])[0]!.selected).toBe(true);
  expect(projectSkillChoices({ ...data, skills: [] }, "owner/repo", ["x"])[0]!.detail).toContain("Unavailable");
});

test("every-session skills report repositories that carry a skill with the same name", () => {
  const data = {
    skills: [
      { id: "x", description: "x", updatedAt: 1, size: 1 },
      { id: "y", description: "y", updatedAt: 1, size: 1 },
    ],
    projects: [{ id: "*", mcp: {}, skills: ["x"], skillRepos: [], inheritDefaults: true }],
    checkouts: [
      { path: "/repo", project: "owner/repo", skills: ["x"], mirror: false },
      { path: "/other", project: "owner/other", skills: ["z"], mirror: false },
    ],
  };
  expect(repoClashes(data, ["x", "y"])).toEqual([{ skill: "x", path: "/repo", project: "owner/repo" }]);
  expect(repoClashes(data, ["y"])).toEqual([]);
  const global = projectSkillChoices(data, "*", ["x"]);
  expect(global.find((c) => c.id === "x")!.detail).toContain("Claude Code runs this one");
  expect(global.find((c) => c.id === "y")!.detail).toBe("");
  // A project's form leads with its own skills and folds away the every-session ones it does not list itself.
  const project = projectSkillChoices(data, "owner/other", ["y"]);
  expect(project.map((c) => [c.id, c.redundant])).toEqual([
    ["y", false],
    ["x", true],
  ]);
});

test("a Use in change touches only the projects it names; the whole-set body still replaces the set", () => {
  const s = new Store(":memory:");
  s.setLocal("node", "test");
  createInstance(s, { name: "fs", target: "filesystem" });
  writeSkillMd(s, "lint", "Lint.");
  const cases = [
    { id: "fs", change: changeServerProjects, uses: (p: Project) => Object.values(p.mcp).includes("fs") },
    { id: "lint", change: changeSkillProjects, uses: (p: Project) => p.skills.includes("lint") },
  ];
  for (const { id, change, uses } of cases) {
    const usedBy = () =>
      s
        .list("project")
        .filter(uses)
        .map((p) => p.id);
    // The dialog opened on a/x; another machine added b/y before it saved.
    change(s, id, projectChangeSchema.parse({ projects: ["a/x", "b/y"] }));
    change(s, id, projectChangeSchema.parse({ add: ["c/z"], remove: ["a/x"] }));
    expect(usedBy()).toEqual(["b/y", "c/z"]);
    change(s, id, projectChangeSchema.parse({ projects: ["a/x"] }));
    expect(usedBy()).toEqual(["a/x"]);
  }
  s.close();
});
