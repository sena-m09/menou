import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import type { CheckDefinition } from "./config";
import { computeFingerprints } from "./fingerprint";
import { type Locations, type Outcome, prepareOutDir, writeRecord } from "./store";

export interface RunCheckOptions {
  cwd: string;
  outDir: string;
  stdio?: "inherit" | "ignore";
  baseline?: string;
  env?: Readonly<Record<string, string>>;
  graceMs?: number;
}

const forwardedSignals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

type Ending =
  | { kind: "exit"; code: number | null; signal: NodeJS.Signals | null }
  | { kind: "spawn"; message: string };

type Interruption = { kind: "timeout" } | { kind: "signal"; signal: NodeJS.Signals };

export async function runCheck(check: CheckDefinition, options: RunCheckOptions): Promise<Outcome> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    MENOU_OUT: options.outDir,
    MENOU_CHECK_ID: check.id,
  };
  delete env.MENOU_BASELINE;
  if (options.baseline !== undefined) env.MENOU_BASELINE = options.baseline;
  Object.assign(env, options.env);

  const child = spawn("/bin/sh", ["-c", check.run], {
    cwd: options.cwd,
    env,
    // 端末から読もうとすると別のプロセスグループでは止まってしまうので、stdin は渡さない。
    stdio: ["ignore", options.stdio ?? "inherit", options.stdio ?? "inherit"],
    // タイムアウトや Ctrl-C で、チェックが起動したプロセスまでまとめて止めるため。
    detached: true,
  });
  const signalGroup = (signal: NodeJS.Signals) => {
    if (child.pid === undefined) return;
    try {
      process.kill(-child.pid, signal);
    } catch {
      // グループが終わったあとの ESRCH なので無視する。
    }
  };
  const finished = new AbortController();

  const ended = new Promise<Ending>((resolve) => {
    child.on("error", (error) => resolve({ kind: "spawn", message: error.message }));
    child.on("exit", (code, signal) => resolve({ kind: "exit", code, signal }));
  });

  const interrupted = new Promise<Interruption>((resolve) => {
    const forward = (signal: NodeJS.Signals) => {
      signalGroup(signal);
      resolve({ kind: "signal", signal });
    };
    for (const signal of forwardedSignals) process.on(signal, forward);
    finished.signal.addEventListener("abort", () => {
      for (const signal of forwardedSignals) process.off(signal, forward);
    });
  });

  const timedOut =
    check.mode === "inline"
      ? sleep(check.timeout * 1000, undefined, { signal: finished.signal }).then(
          (): Interruption => {
            signalGroup("SIGTERM");
            void sleep(options.graceMs ?? 5000, undefined, { signal: finished.signal }).then(
              () => signalGroup("SIGKILL"),
              () => {},
            );
            return { kind: "timeout" };
          },
        )
      : new Promise<never>(() => {});

  try {
    const first = await Promise.race([ended, interrupted, timedOut]);
    switch (first.kind) {
      case "spawn":
        return { result: "error", cause: { kind: "spawn", message: first.message } };
      case "exit":
        return judgeExit(first.code, first.signal);
      case "timeout":
      case "signal":
        await ended;
        signalGroup("SIGKILL");
        return first.kind === "timeout"
          ? { result: "error", cause: { kind: "timeout", seconds: check.timeout } }
          : { result: "error", cause: { kind: "signal", signal: first.signal } };
    }
  } finally {
    finished.abort();
  }
}

export type RecordedRunOptions = Omit<RunCheckOptions, "cwd" | "outDir">;

export async function runAndRecord(
  locations: Locations,
  check: CheckDefinition,
  options: RecordedRunOptions,
): Promise<Outcome> {
  const fingerprintNow = () =>
    computeFingerprints(locations.root, [check]).fingerprints.get(check.id) ?? "";
  const before = fingerprintNow();
  const outDir = prepareOutDir(locations, check.id);
  const ran = await runCheck(check, { ...options, cwd: locations.root, outDir });
  const outcome: Outcome =
    fingerprintNow() === before ? ran : { result: "error", cause: { kind: "modified" } };

  writeRecord(locations, {
    id: check.id,
    fingerprint: before,
    finishedAt: new Date().toISOString(),
    gitDir: locations.gitDir,
    ...outcome,
  });
  return outcome;
}

function judgeExit(code: number | null, signal: NodeJS.Signals | null): Outcome {
  if (signal !== null) return { result: "error", cause: { kind: "signal", signal } };
  if (code === 0) return { result: "pass" };
  if (code === 1) return { result: "fail" };
  return { result: "error", cause: { kind: "exit", code: code ?? -1 } };
}
