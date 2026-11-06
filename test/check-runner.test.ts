import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { runCheck } from "../src/check-runner";
import type { CheckDefinition } from "../src/config";

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
  it("0 で終われば合格", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "menou-runner-")));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));

    expect(await runIn(dir, check("exit 0"))).toEqual({ result: "pass" });
  });

  it("1 で終われば不合格", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "menou-runner-")));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));

    expect(await runIn(dir, check("exit 1"))).toEqual({ result: "fail" });
  });

  it.each([2, 3, 255])("%i で終われば、不合格と区別してエラーにする", async (code) => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "menou-runner-")));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));

    expect(await runIn(dir, check(`exit ${code}`))).toEqual({
      result: "error",
      cause: { kind: "exit", code },
    });
  });

  it("コマンドが見つからなければ、シェルが返す 127 のエラーにする", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "menou-runner-")));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));

    expect(await runIn(dir, check("menou-no-such-command"))).toEqual({
      result: "error",
      cause: { kind: "exit", code: 127 },
    });
  });

  it.each(["TERM", "KILL"])("シグナル（SIG%s）で終われば、エラーにする", async (signal) => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "menou-runner-")));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));

    expect(await runIn(dir, check(`kill -${signal} $$`))).toEqual({
      result: "error",
      cause: { kind: "signal", signal: `SIG${signal}` },
    });
  });

  it("実行できなければ（作業ディレクトリがないなど）、エラーにする", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "menou-runner-")));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));

    const outcome = await runCheck(check("exit 0"), {
      cwd: join(dir, "missing"),
      outDir: dir,
      stdio: "ignore",
    });

    expect(outcome).toMatchObject({ result: "error", cause: { kind: "spawn" } });
  });
});

describe("タイムアウト", () => {
  it("inline 方式で timeout の秒数を過ぎたら止めて、エラーにする", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "menou-runner-")));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));

    const started = Date.now();

    const outcome = await runIn(dir, check("sleep 30", { timeout: 1 }));

    expect(outcome).toEqual({ result: "error", cause: { kind: "timeout", seconds: 1 } });
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("inline 方式で timeout の秒数より前に終われば、その終了コードで判定する", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "menou-runner-")));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));

    expect(await runIn(dir, check("sleep 0.1", { timeout: 5 }))).toEqual({ result: "pass" });
  });

  it("evidence 方式には timeout を効かせない", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "menou-runner-")));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));

    expect(await runIn(dir, check("sleep 1.5", { mode: "evidence", timeout: 1 }))).toEqual({
      result: "pass",
    });
  });

  it("止めるときは、チェックのコマンドが起動したプロセスもまとめて止める", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "menou-runner-")));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));

    const pidFile = join(dir, "pid");

    await runIn(dir, check(`sleep 30 & echo $! > "${pidFile}"; wait`, { timeout: 1 }));

    const pid = Number(readFileSync(pidFile, "utf8"));
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), { timeout: 2000 });
  });

  it("SIGTERM を無視するコマンドは、待ったあとに SIGKILL で止める", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "menou-runner-")));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));

    const outcome = await runIn(dir, check("trap '' TERM; sleep 30", { timeout: 1 }), 200);

    expect(outcome).toEqual({ result: "error", cause: { kind: "timeout", seconds: 1 } });
  });

  it("SIGTERM を受けたコマンドが後片付けを終えるまで待ってから、タイムアウトのエラーにする", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "menou-runner-")));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));

    const cleaned = join(dir, "cleaned");

    const outcome = await runIn(
      dir,
      check(`trap 'sleep 0.2; echo done > "${cleaned}"; exit 0' TERM; sleep 30 & wait`, {
        timeout: 1,
      }),
    );

    expect(outcome).toEqual({ result: "error", cause: { kind: "timeout", seconds: 1 } });
    expect(existsSync(cleaned)).toBe(true);
  });
});

describe("チェックのコマンドに渡すもの", () => {
  it("MENOU_OUT と MENOU_CHECK_ID を渡す", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "menou-runner-")));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));

    const outDir = join(dir, "out");
    const outcome = await runCheck(
      check(`test "$MENOU_CHECK_ID" = lint && test "$MENOU_OUT" = "${outDir}"`),
      { cwd: dir, outDir, stdio: "ignore" },
    );

    expect(outcome).toEqual({ result: "pass" });
  });

  it("menou を呼んだ環境に MENOU_BASELINE があっても、チェックのコマンドには渡さない", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "menou-runner-")));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));

    vi.stubEnv("MENOU_BASELINE", "0000");

    expect(await runIn(dir, check('test -z "$MENOU_BASELINE"'))).toEqual({ result: "pass" });
  });

  it("menou を呼んだ環境のほかの変数は、そのまま渡す", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "menou-runner-")));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));

    vi.stubEnv("MENOU_TEST_VALUE", "kept");

    expect(await runIn(dir, check('test "$MENOU_TEST_VALUE" = kept'))).toEqual({ result: "pass" });
  });

  it("渡した作業ディレクトリで実行する", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "menou-runner-")));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));

    expect(await runIn(dir, check(`test "$(pwd -P)" = "${dir}"`))).toEqual({ result: "pass" });
  });
});
