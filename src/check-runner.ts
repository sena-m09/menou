import { spawn } from "node:child_process";
import type { CheckDefinition } from "./config";
import type { Outcome } from "./store";

export interface RunCheckOptions {
  cwd: string;
  outDir: string;
  stdio?: "inherit" | "ignore";
  graceMs?: number;
}

const forwardedSignals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

export function runCheck(check: CheckDefinition, options: RunCheckOptions): Promise<Outcome> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    MENOU_OUT: options.outDir,
    MENOU_CHECK_ID: check.id,
  };
  delete env.MENOU_BASELINE;

  return new Promise((resolve) => {
    const child = spawn("/bin/sh", ["-c", check.run], {
      cwd: options.cwd,
      env,
      // 端末から読もうとすると別のプロセスグループでは止まってしまうので、stdin は渡さない。
      stdio: ["ignore", options.stdio ?? "inherit", options.stdio ?? "inherit"],
      // タイムアウトや Ctrl-C で、チェックが起動したプロセスまでまとめて止めるため。
      detached: true,
    });

    let timedOut = false;
    let interruptedBy: NodeJS.Signals | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    const signalGroup = (signal: NodeJS.Signals) => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, signal);
      } catch {
        // グループが終わったあとの ESRCH なので無視する。
      }
    };
    const forward = (signal: NodeJS.Signals) => {
      interruptedBy = signal;
      signalGroup(signal);
    };
    for (const signal of forwardedSignals) process.on(signal, forward);

    const timeoutTimer =
      check.mode === "inline"
        ? setTimeout(() => {
            timedOut = true;
            signalGroup("SIGTERM");
            killTimer = setTimeout(() => signalGroup("SIGKILL"), options.graceMs ?? 5000);
          }, check.timeout * 1000)
        : undefined;

    const finish = (outcome: Outcome) => {
      clearTimeout(timeoutTimer);
      clearTimeout(killTimer);
      for (const signal of forwardedSignals) process.off(signal, forward);
      resolve(outcome);
    };

    child.on("error", (error) => {
      finish({ result: "error", cause: { kind: "spawn", message: error.message } });
    });

    child.on("exit", (code, signal) => {
      if (timedOut || interruptedBy !== undefined) signalGroup("SIGKILL");
      if (timedOut) {
        finish({ result: "error", cause: { kind: "timeout", seconds: check.timeout } });
      } else if (interruptedBy !== undefined || signal !== null) {
        finish({
          result: "error",
          cause: { kind: "signal", signal: interruptedBy ?? signal ?? "" },
        });
      } else if (code === 0) {
        finish({ result: "pass" });
      } else if (code === 1) {
        finish({ result: "fail" });
      } else {
        finish({ result: "error", cause: { kind: "exit", code: code ?? -1 } });
      }
    });
  });
}
