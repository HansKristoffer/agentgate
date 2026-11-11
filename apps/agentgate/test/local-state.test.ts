import { expect, test } from "bun:test";
import { z } from "zod";
import { defineLocal } from "../src/local-state.ts";
import { Store } from "../src/store.ts";

test("a typed local key writes and announces only a real change", () => {
  const s = new Store(":memory:");
  const bumps: string[] = [];
  s.onChange = (topic) => bumps.push(topic);
  const lag = defineLocal("lag:", z.object({ ms: z.number() }), { topic: "status" });
  expect(lag.set(s, "a", { ms: 5 })).toBe(true);
  expect(bumps).toEqual(["status"]);
  expect(lag.set(s, "a", { ms: 5 })).toBe(false);
  expect(bumps).toEqual(["status"]);
  expect(lag.get(s, "a")).toEqual({ ms: 5 });
  expect(lag.set(s, "a", undefined)).toBe(true);
  expect(lag.get(s, "a")).toBeUndefined();
  s.close();
});

test("an unreadable row reads as missing and a plain string key reads rows written before it was typed", () => {
  const s = new Store(":memory:");
  s.setLocal("lag:a", "{not json");
  s.setLocal("lag:b", '{"ms":"slow"}');
  const lag = defineLocal("lag:", z.object({ ms: z.number() }));
  expect([lag.get(s, "a"), lag.get(s, "b")]).toEqual([undefined, undefined]);
  s.setLocal("active:claude", "work");
  expect(defineLocal("active:", z.string()).get(s, "claude")).toBe("work");
  s.close();
});
