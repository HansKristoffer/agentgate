import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Replace a file only after its complete contents have reached disk. */
export function atomicWrite(file: string, content: string) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(temp, "wx", 0o600); writeFileSync(fd, content); fsyncSync(fd); closeSync(fd); fd = undefined;
    renameSync(temp, file);
  } finally { if (fd !== undefined) closeSync(fd); try { unlinkSync(temp); } catch { } }
}
