// The parts of tinyjs (https://tinyjs.app/api.html) this app uses: `tiny` is injected into the page,
// `tjs` is the txiki.js runtime the backend (main.ts) runs on.

interface TinyMenuItem {
  id?: string;
  label?: string;
  checked?: boolean;
  enabled?: boolean;
  separator?: boolean;
}

declare const tiny: {
  api: { call(method: string, params?: unknown): Promise<unknown> };
  app: {
    info(): Promise<{ version: string }>;
    shell: { open(target: string): Promise<true> };
  };
  dialog: {
    openFile(opts?: { types?: string[] }): Promise<string | null>;
    pickFolder(): Promise<string | null>;
    saveFile(opts?: { types?: string[] }): Promise<string | null>;
    confirm(message: string, opts?: { detail?: string; ok?: string; cancel?: string }): Promise<boolean>;
  };
  tray: {
    set(spec: { title?: string; tooltip?: string; menu?: TinyMenuItem[] }): Promise<unknown>;
    remove(): Promise<unknown>;
    on(fn: (id: string) => void): void;
  };
  win: {
    show(): Promise<unknown>;
    restore(): Promise<unknown>;
    setMinSize(width: number, height: number): Promise<unknown>;
  };
  notify(title: string, body?: string): Promise<boolean>;
};

interface TjsProcess {
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  wait(): Promise<{ exit_status: number; term_signal: number | null }>;
  kill(): void;
}

declare const tjs: {
  env: Record<string, string | undefined>;
  exePath: string;
  cwd: string;
  homeDir: string;
  tmpDir: string;
  makeTempDir(template: string): Promise<string>;
  readFile(path: string): Promise<Uint8Array>;
  open(path: string, flags: string, mode?: number): Promise<{
    write(data: Uint8Array): Promise<number>;
    sync(): Promise<void>;
    close(): Promise<void>;
  }>;
  rename(from: string, to: string): Promise<void>;
  remove(path: string, opts?: { recursive?: boolean }): Promise<void>;
  makeDir(path: string, opts?: { recursive?: boolean }): Promise<void>;
  copyFile(from: string, to: string): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  spawn(
    args: string[],
    opts: { env?: Record<string, string | undefined>; stdin?: "ignore"; stdout?: "pipe"; stderr?: "pipe" },
  ): TjsProcess;
};
