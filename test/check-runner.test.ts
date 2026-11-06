import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, vi } from "vitest";
import { runCheck } from "../src/check-runner";
import type { CheckDefinition } from "../src/config";
import { testWithTempDir } from "./temp-dir";
import { isAlive, waitUntil } from "./wait";

const it = testWithTempDir("menou-runner-");

afterEach(() => {
  vi.unstubAllEnvs();
});

function check(run: string, overrides: Partial<CheckDefinition> = {}): CheckDefinition {
  return {
    id: "lint",
    mode: "inline",
    run,
    paths: ["**"],
    severity: "block",
    timeout: 120,
    ...overrides,
  };
}

function runIn(dir: string, definition: CheckDefinition, graceMs?: number) {
  return runCheck(definition, { cwd: dir, outDir: dir, stdio: "ignore", graceMs });
}

describe("終了コードの扱い", () => {
  it("0 で終われば合格", async ({ dir }) => {
    expect(await runIn(dir, check("exit 0"))).toEqual({ result: "pass" });
  });

  it("1 で終われば不合格", async ({ dir }) => {
    expect(await runIn(dir, check("exit 1"))).toEqual({ result: "fail" });
  });

  it.for([2, 3, 255])("%i で終われば、不合格と区別してエラーにする", async (code, { dir }) => {
    expect(await runIn(dir, check(`exit ${code}`))).toEqual({
      result: "error",
      cause: { kind: "exit", code },
    });
  });

  it("コマンドが見つからなければ、シェルが返す 127 のエラーにする", async ({ dir }) => {
    expect(await runIn(dir, check("menou-no-such-command"))).toEqual({
      result: "error",
      cause: { kind: "exit", code: 127 },
    });
  });

  it.for(["TERM", "KILL"])("シグナル（SIG%s）で終われば、エラーにする", async (signal, { dir }) => {
    expect(await runIn(dir, check(`kill -${signal} $$`))).toEqual({
      result: "error",
      cause: { kind: "signal", signal: `SIG${signal}` },
    });
  });

  it("実行できなければ（作業ディレクトリがないなど）、エラーにする", async ({ dir }) => {
    const outcome = await runCheck(check("exit 0"), {
      cwd: join(dir, "missing"),
      outDir: dir,
      stdio: "ignore",
    });

    expect(outcome).toMatchObject({ result: "error", cause: { kind: "spawn" } });
  });
});

describe("タイムアウト", () => {
  it("inline 方式で timeout の秒数を過ぎたら止めて、エラーにする", async ({ dir }) => {
    const started = Date.now();

    const outcome = await runIn(dir, check("sleep 30", { timeout: 1 }));

    expect(outcome).toEqual({ result: "error", cause: { kind: "timeout", seconds: 1 } });
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("inline 方式で timeout の秒数より前に終われば、その終了コードで判定する", async ({ dir }) => {
    expect(await runIn(dir, check("sleep 0.1", { timeout: 5 }))).toEqual({ result: "pass" });
  });

  it("evidence 方式には timeout を効かせない", async ({ dir }) => {
    expect(await runIn(dir, check("sleep 1.5", { mode: "evidence", timeout: 1 }))).toEqual({
      result: "pass",
    });
  });

  it("止めるときは、チェックのコマンドが起動したプロセスもまとめて止める", async ({ dir }) => {
    const pidFile = join(dir, "pid");

    await runIn(dir, check(`sleep 30 & echo $! > "${pidFile}"; wait`, { timeout: 1 }));

    const pid = Number(readFileSync(pidFile, "utf8"));
    expect(await waitUntil(() => !isAlive(pid))).toBe(true);
  });

  it("SIGTERM を無視するコマンドは、待ったあとに SIGKILL で止める", async ({ dir }) => {
    const outcome = await runIn(dir, check("trap '' TERM; sleep 30", { timeout: 1 }), 200);

    expect(outcome).toEqual({ result: "error", cause: { kind: "timeout", seconds: 1 } });
  });
});

describe("チェックのコマンドに渡すもの", () => {
  it("MENOU_OUT と MENOU_CHECK_ID を渡す", async ({ dir }) => {
    const outDir = join(dir, "out");
    const outcome = await runCheck(
      check(`test "$MENOU_CHECK_ID" = lint && test "$MENOU_OUT" = "${outDir}"`),
      { cwd: dir, outDir, stdio: "ignore" },
    );

    expect(outcome).toEqual({ result: "pass" });
  });

  it("menou を呼んだ環境に MENOU_BASELINE があっても、チェックのコマンドには渡さない", async ({
    dir,
  }) => {
    vi.stubEnv("MENOU_BASELINE", "0000");

    expect(await runIn(dir, check('test -z "$MENOU_BASELINE"'))).toEqual({ result: "pass" });
  });

  it("menou を呼んだ環境のほかの変数は、そのまま渡す", async ({ dir }) => {
    vi.stubEnv("MENOU_TEST_VALUE", "kept");

    expect(await runIn(dir, check('test "$MENOU_TEST_VALUE" = kept'))).toEqual({ result: "pass" });
  });

  it("渡した作業ディレクトリで実行する", async ({ dir }) => {
    expect(await runIn(dir, check(`test "$(pwd -P)" = "${dir}"`))).toEqual({ result: "pass" });
  });
});
