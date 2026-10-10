import { expect, test } from "bun:test";
import { mkdtemp, open, readFile, rename, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The backend runs on txiki.js; give it the few `tjs` calls these tests reach.
Object.assign(globalThis, {
  tjs: {
    env: {},
    exePath: "/usr/local/bin/tjs",
    cwd: process.cwd(),
    homeDir: tmpdir(),
    open: async (path: string, flags: string, mode: number) => {
      const file = await open(path, flags, mode);
      return { write: (data: Uint8Array) => file.write(data), sync: () => file.sync(), close: () => file.close() };
    },
    rename,
    remove: (path: string) => rm(path),
  },
});
const { defaultConnection, endpoint, privateWrite, requireLocal } = await import("./main.ts");

test("service controls require the configured local daemon", () => {
  const local = defaultConnection();
  expect(() => requireLocal(local)).not.toThrow();
  expect(() => requireLocal({ url: local.url.replace("127.0.0.1", "localhost") })).not.toThrow();
  expect(() => requireLocal({ url: "http://127.0.0.1:7879" })).toThrow();
  expect(() => requireLocal({ url: "https://127.0.0.1:7878" })).toThrow();
  expect(() => requireLocal({ url: "http://server.tailnet.ts.net:7878" })).toThrow();
});

test("the bridge keeps requests in the control API", () => {
  const connection = { url: "http://127.0.0.1:7878" };
  expect(endpoint(connection, "/projects/tools?id=owner%2Frepo").href).toBe(
    "http://127.0.0.1:7878/api/projects/tools?id=owner%2Frepo",
  );
  for (const path of ["//evil.test", "/../peer", "/%2e%2e/peer", "/status#fragment", "/status\\oops"])
    expect(() => endpoint(connection, path)).toThrow();
  for (const url of ["file:///etc/passwd", "http://user:secret@host", "http://localhost/api", "http://localhost?token=x"])
    expect(() => endpoint({ url }, "/status")).toThrow();
});

test("private files are atomically replaced", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agentgate-desktop-"));
  const file = join(dir, "backup.json");
  await privateWrite(file, new TextEncoder().encode("first"));
  await privateWrite(file, new TextEncoder().encode("second"));
  expect(await readFile(file, "utf8")).toBe("second");
  expect((await stat(file)).mode & 0o777).toBe(0o600);
  await rm(dir, { recursive: true });
});
