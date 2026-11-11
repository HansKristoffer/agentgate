/// <reference types="bun" />
// The app's tsconfig loads only the browser's types; this test runs under Bun.
import { describe, expect, test } from "bun:test";
import { TOPICS } from "@agentgate/protocol";
import { moved } from "./useChanges.ts";
import { reuse } from "./useDaemon.ts";

describe("reuse", () => {
  test("an answer equal to the last one is the last one", () => {
    const prev = { node: "a", accounts: [{ id: "x", used: 1 }], relay: null };
    expect(reuse(prev, structuredClone(prev))).toBe(prev);
  });

  test("a changed answer keeps every part that did not change", () => {
    const prev = {
      node: "a",
      accounts: [
        { id: "x", used: 1 },
        { id: "y", used: 2 },
      ],
      servers: [{ id: "s" }],
    };
    const next = {
      node: "a",
      accounts: [
        { id: "x", used: 1 },
        { id: "y", used: 3 },
      ],
      servers: [{ id: "s" }],
    };
    const shared = reuse(prev, next);
    expect(shared).toEqual(next);
    expect(shared).not.toBe(prev);
    expect(shared.servers).toBe(prev.servers);
    expect(shared.accounts[0]).toBe(prev.accounts[0]!);
    expect(shared.accounts[1]).not.toBe(prev.accounts[1]!);
  });

  test("a field that appears or goes away is a change, even when undefined", () => {
    const prev: { list: number[]; flag?: boolean } = { list: [1, 2], flag: undefined };
    const without = { list: [1, 2] };
    expect(reuse(prev, without)).not.toBe(prev);
    expect(reuse(without, prev)).not.toBe(without);
  });
});

describe("moved", () => {
  test("a daemon without versions moves every topic", () => {
    expect(moved(undefined, undefined)).toEqual([...TOPICS]);
    expect(moved({ status: 1 }, undefined)).toEqual([...TOPICS]);
  });

  test("only the topics whose counter changed move, and unknown topics are ignored", () => {
    const before = { status: 1, desktop: 1, factory: 1, threads: 1, activity: 1, someday: 1 };
    expect(moved(before, { ...before, factory: 2, someday: 2 })).toEqual(["factory"]);
    expect(moved(before, { ...before, someday: 2 })).toEqual([]);
  });

  test("a topic the daemon does not report always moves", () => {
    const before = { status: 1, desktop: 1, factory: 1, threads: 1 };
    expect(moved(before, { ...before, status: 2 })).toEqual(["status", "activity"]);
  });
});
