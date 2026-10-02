import { expect, test } from "bun:test";
import { projectSkillChoices } from "../../desktop/src/skill-assignment.ts";

test("derived availability preserves explicit assignments across global and checkout changes", () => {
  const data = {
    skills: [{ id: "x", description: "x", updatedAt: 1, size: 1 }],
    projects: [{ id: "*", mcp: {}, skills: ["x"], inheritDefaults: true }],
    checkouts: [{ path: "/repo", project: "Owner/Repo", skills: ["x"], mirror: false }],
  };
  const choices = projectSkillChoices(data, "owner/repo", ["x"]);
  expect(choices).toHaveLength(1); expect(choices[0]!.selected).toBe(true);
  expect(choices[0]!.detail).toContain("every session"); expect(choices[0]!.detail).toContain("local repository");
  data.projects[0]!.skills = []; data.checkouts = [];
  expect(projectSkillChoices(data, "owner/repo", ["x"])[0]!.selected).toBe(true);
  expect(projectSkillChoices({ ...data, skills: [] }, "owner/repo", ["x"])[0]!.detail).toContain("Unavailable");
});
