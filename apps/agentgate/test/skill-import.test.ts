import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SkillImports, runSkillCommand, parseSkillOutput, type FetchedSkill } from "../src/skill-import.ts";

const pack = (id = "x", text = "instructions"): FetchedSkill[] => [{ id, description: id, files: [{ path: "SKILL.md", data: Buffer.from(text).toString("base64") }] }];

test("preview fetches coalesce and mutable caller data cannot change an artifact", async () => {
  const gate = Promise.withResolvers<FetchedSkill[]>();
  let calls = 0;
  const imports = new SkillImports(async () => { calls++; return gate.promise; });
  try {
    const a = imports.preview("owner/pack"), b = imports.preview("owner/pack");
    gate.resolve(pack());
    const [first, second] = await Promise.all([a, b]);
    expect(calls).toBe(1); expect(first.token).toBe(second.token);
    first.skills[0]!.files[0]!.data = "changed";
    expect(imports.get(first.token).skills[0]!.files[0]!.data).toBe(Buffer.from("instructions").toString("base64"));
  } finally { imports.close(); await imports.drain(); }
});

test("preview cache bounds retained bytes, expires artifacts, and uses unambiguous keys", async () => {
  let now = 0;
  const bytes = Buffer.byteLength(JSON.stringify(pack()));
  const imports = new SkillImports(async () => pack(), () => now, bytes + 1, 100);
  try {
    const first = await imports.preview("owner/pack#part", "x");
    const second = await imports.preview("owner/pack", "part#x");
    expect(first.token).not.toBe(second.token);
    expect(() => imports.get(first.token)).toThrow(/evicted/);
    now = 100; expect(() => imports.get(second.token)).toThrow(/expired/);
  } finally { imports.close(); await imports.drain(); }
});

test("cancelled preview callers release work only when the last subscriber leaves", async () => {
  let aborted = false;
  const gate = Promise.withResolvers<FetchedSkill[]>();
  const imports = new SkillImports(async (_source, _selector, signal) => {
    signal!.addEventListener("abort", () => { aborted = true; gate.reject(signal!.reason); }, { once: true });
    return gate.promise;
  });
  const abortA = new AbortController(), abortB = new AbortController();
  const a = imports.preview("owner/pack", "*", abortA.signal), b = imports.preview("owner/pack", "*", abortB.signal);
  abortA.abort(new Error("cancel A"));
  await expect(a).rejects.toThrow("cancel A"); expect(aborted).toBe(false);
  abortB.abort(new Error("cancel B"));
  await expect(b).rejects.toThrow("cancel B");
  expect(aborted).toBe(true);
  imports.close(); await imports.drain();
});

test("closing the importer cancels work and rejects additional imports", async () => {
  let aborted = false;
  const imports = new SkillImports((_source, _selector, signal) => new Promise((_, reject) => {
    signal!.addEventListener("abort", () => { aborted = true; reject(new Error("shutdown")); }, { once: true });
  }));
  const running = imports.preview("owner/pack"); imports.close();
  await expect(running).rejects.toThrow("shutdown"); await imports.drain(); expect(aborted).toBe(true);
  await expect(imports.preview("another/pack")).rejects.toThrow(/closed/);
});

test("the importer rejects excess concurrency and malformed packs", async () => {
  const gates = [Promise.withResolvers<FetchedSkill[]>(), Promise.withResolvers<FetchedSkill[]>()];
  let calls = 0;
  const imports = new SkillImports(async () => gates[calls++]!.promise);
  const a = imports.preview("one/pack"), b = imports.preview("two/pack");
  await expect(imports.preview("three/pack")).rejects.toThrow(/already running/);
  gates[0]!.resolve(pack()); gates[1]!.resolve([{ ...pack()[0]!, files: [] }]);
  await expect(b).rejects.toThrow(); await a;
  imports.close(); await imports.drain();
});

test("CLI output and cancellation deadlines terminate subprocess groups", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agentgate-command-test-"));
  try {
    await expect(runSkillCommand([process.execPath, "-e", "console.log('x'.repeat(10000))"], dir, AbortSignal.timeout(5000), 100)).rejects.toThrow(/limit/);
    const started = Date.now();
    await expect(runSkillCommand([process.execPath, "-e", "setInterval(() => {}, 1000)"], dir, AbortSignal.timeout(50))).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(2000);
    await expect(runSkillCommand([process.execPath, "-e", "import {spawn} from 'node:child_process'; spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio:'inherit'}); process.exit(0)"], dir, AbortSignal.timeout(100))).rejects.toThrow();
    const good = await runSkillCommand([process.execPath, "-e", "console.log('[]')"], dir, AbortSignal.timeout(5000));
    expect(good.code).toBe(0); expect(JSON.parse(good.out)).toEqual([]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the pinned CLI JSON contract reports invalid and incompatible output clearly", () => {
  expect(() => parseSkillOutput("log lines instead of JSON")).toThrow(/invalid JSON/);
  expect(() => parseSkillOutput('{"results":[]}')).toThrow(/incompatible JSON/);
  expect(() => parseSkillOutput('[{"status":"installed"}]')).toThrow(/path/);
  expect(parseSkillOutput('[{"name":"x","status":"installed","path":"/scratch/x","hash":null,"security":{"gen":"low"}}]')[0]!.name).toBe("x");
});

test("updates fetch fresh contents without replacing an existing reviewed preview", async () => {
  let version = 0;
  const imports = new SkillImports(async () => pack("x", `version-${++version}`));
  try {
    const preview = await imports.preview("owner/pack");
    const fresh = await imports.fetchFresh("owner/pack");
    expect(version).toBe(2);
    expect(Buffer.from(fresh[0]!.files[0]!.data, "base64").toString()).toBe("version-2");
    expect(Buffer.from(imports.get(preview.token).skills[0]!.files[0]!.data, "base64").toString()).toBe("version-1");
  } finally { imports.close(); await imports.drain(); }
});
