import { expect, test } from "bun:test";
import { projectSkillChoices, repoClashes } from "../../desktop/src/skill-assignment.ts";

test("derived availability preserves explicit assignments across global and checkout changes", () => {
  const data = {
    skills: [{ id: "x", description: "x", updatedAt: 1, size: 1 }],
    projects: [{ id: "*", mcp: {}, skills: ["x"], skillRepos: [], inheritDefaults: true }],
    checkouts: [{ path: "/repo", project: "Owner/Repo", skills: ["x"], mirror: false }],
  };
  const choices = projectSkillChoices(data, "owner/repo", ["x"]);
  expect(choices).toHaveLength(1); expect(choices[0]!.selected).toBe(true);
  expect(choices[0]!.detail).toContain("every session"); expect(choices[0]!.detail).toContain("local repository");
  data.projects[0]!.skills = []; data.checkouts = [];
  expect(projectSkillChoices(data, "owner/repo", ["x"])[0]!.selected).toBe(true);
  expect(projectSkillChoices({ ...data, skills: [] }, "owner/repo", ["x"])[0]!.detail).toContain("Unavailable");
});

test("every-session skills report repositories that carry a skill with the same name", () => {
  const data = {
    skills: [{ id: "x", description: "x", updatedAt: 1, size: 1 }, { id: "y", description: "y", updatedAt: 1, size: 1 }],
    projects: [{ id: "*", mcp: {}, skills: ["x"], skillRepos: [], inheritDefaults: true }],
    checkouts: [{ path: "/repo", project: "owner/repo", skills: ["x"], mirror: false }, { path: "/other", project: "owner/other", skills: ["z"], mirror: false }],
  };
  expect(repoClashes(data, ["x", "y"])).toEqual([{ skill: "x", path: "/repo", project: "owner/repo" }]);
  expect(repoClashes(data, ["y"])).toEqual([]);
  const global = projectSkillChoices(data, "*", ["x"]);
  expect(global.find(c => c.id === "x")!.detail).toContain("Claude Code runs this one");
  expect(global.find(c => c.id === "y")!.detail).toBe("");
});
