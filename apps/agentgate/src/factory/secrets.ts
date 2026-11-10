import { factorySecretInputSchema, secretNameSchema } from "@agentgate/protocol";
import { z } from "zod";
import type { Store } from "../store.ts";
import { currentFolder } from "./config.ts";
import { noWords, operation, requireFactoryProtocol, UsageError, type FactoryRuntime } from "./runtime.ts";

/**
 * The factory's secrets: values the folder names as `secret:NAME`, set from the CLI and kept as synced `secret` records
 * so whichever machine runs the factory has them. A value is only ever read back by the code that uses it; lists show
 * names, and no error names a value.
 */

/** A user secret by name, or one of agentgate's own: a `~hook:<source>` key or the `~notify` URL. */
export function getSecret(s: Store, name: string) {
  return s.get("secret", name)?.value;
}

/** Synced to every node, so it waits until none of them would stall on the record kind. */
export function setSecret(s: Store, name: string, value: string) {
  requireFactoryProtocol(s);
  s.put("secret", name, { id: name, value, from: s.nodeId });
}

/** A tombstone, so a machine that was offline cannot bring the value back. */
export function deleteSecret(s: Store, name: string) {
  s.del("secret", name);
}

/** User secrets only: `~` ids are agentgate's own. */
export function secretNames(s: Store) {
  return s
    .list("secret")
    .map((r) => r.id)
    .filter((id) => !id.startsWith("~"));
}

/** `secret:NAME` to its value; undefined for any other string or a name that is not set. */
export function resolveSecretRef(s: Store, ref: string) {
  return ref.startsWith("secret:") ? getSecret(s, ref.slice("secret:".length)) : undefined;
}

/** The names set, and the names the loaded folder declares that this machine lacks. */
export function secretList(f: FactoryRuntime) {
  const set = secretNames(f.s);
  const missing = (currentFolder(f)?.secrets ?? []).filter((name) => !set.includes(name));
  return { set, missing };
}

// What a terminal is told about a name or a value its operation would refuse. Neither echoes the input: a value typed
// where the name goes would land in it.
const NAME_RULE = "a secret name is capital letters, digits and _, starting with a letter, such as LINEAR_KEY";
const oneName = (args: string[]) => {
  if (args.length !== 1) throw new UsageError();
  if (!secretNameSchema.safeParse(args[0]).success) throw new Error(NAME_RULE);
  return args[0];
};

/** A value piped on stdin, without the newline `echo` adds. */
const stdinValue = (stdin: string | undefined) => {
  const value = stdin?.replace(/\r?\n$/, "");
  if (!value) throw new Error('pipe the value on stdin: printf %s "$VALUE" | agentgate factory secret set NAME');
  if (!factorySecretInputSchema.shape.value.safeParse(value).success)
    throw new Error("a secret value is at most 16384 characters");
  return value;
};

/** Secrets are every machine's, so their operations run where they are asked, and only for a caller on that machine:
 * a tailnet caller never sets or sees them. */
export function setup(f: FactoryRuntime): void {
  f.checks.push({
    name: "Secrets",
    run() {
      if (!currentFolder(f)) return [];
      const { missing } = secretList(f);
      return [
        {
          id: "secrets",
          title: "Every secret:NAME the folder names is set",
          state: missing.length ? "fail" : "ok",
          ...(missing.length && {
            detail: `${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not set`,
            fix: `printf %s "$VALUE" | agentgate factory secret set ${missing[0]}`,
          }),
        },
      ];
    },
  });
  operation(f, {
    name: "secret set",
    summary: "set a secret on every machine; the value comes on stdin",
    input: factorySecretInputSchema,
    local: true,
    loopbackOnly: true,
    run({ name, value }) {
      setSecret(f.s, name, value);
      return { name };
    },
    terminal: {
      usage: "secret set <NAME> < value",
      stdin: true,
      parse: (args, stdin) => ({ input: { name: oneName(args), value: stdinValue(stdin) } }),
      print: ({ name }) => [`Set ${name} for every machine.`],
    },
  });
  operation(f, {
    name: "secret list",
    summary: "the names set, and those factory.yaml names that are missing",
    input: z.object({}),
    local: true,
    loopbackOnly: true,
    run: () => secretList(f),
    terminal: {
      usage: "secret list",
      parse: noWords,
      print: ({ set, missing }) =>
        set.length || missing.length
          ? [...set, ...missing.map((name) => `${name}  not set (named in factory.yaml)`)]
          : ["No factory secrets."],
    },
  });
  operation(f, {
    name: "secret delete",
    summary: "delete a secret on every machine",
    input: z.object({ name: secretNameSchema }),
    local: true,
    loopbackOnly: true,
    run({ name }) {
      const deleted = getSecret(f.s, name) !== undefined;
      if (deleted) deleteSecret(f.s, name);
      return { name, deleted };
    },
    terminal: {
      usage: "secret delete <NAME>",
      parse: (args) => ({ input: { name: oneName(args) } }),
      print: ({ name, deleted }) =>
        deleted ? [`Deleted ${name} on every machine.`] : { lines: [`${name} is not set.`], code: 1 },
    },
  });
}
