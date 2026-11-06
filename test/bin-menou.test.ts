import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it, onTestFinished, vi } from "vitest";
import { createRepo, type Repo } from "./repo";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const wrapper = join(repoRoot, "bin/menou");

function runWrapper(pathDir: string, args: string[]) {
  return spawnSync(wrapper, args, {
    env: { PATH: pathDir },
    encoding: "utf8",
  });
}

describe("bin/menou", () => {
  it("node があれば、まとめた JS に引数をそのまま渡して実行する", () => {
    const dir = mkdtempSync(join(tmpdir(), "menou-bin-"));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));

    const fakeNode = join(dir, "node");
    writeFileSync(fakeNode, "#!/bin/sh\nprintf '%s\\n' \"$@\"\n");
    chmodSync(fakeNode, 0o755);

    const result = runWrapper(dir, ["run", "lint"]);

    expect(result.status).toBe(0);
    const [script, ...args] = result.stdout.trimEnd().split("\n");
    expect(resolve(script ?? "")).toBe(join(repoRoot, "dist/menou.cjs"));
    expect(args).toEqual(["run", "lint"]);
  });

  it("node が PATH になければ、そのことを知らせて終了コード 127 で止まる", () => {
    const dir = mkdtempSync(join(tmpdir(), "menou-bin-"));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));

    const result = runWrapper(dir, ["run", "lint"]);

    expect(result.status).toBe(127);
    expect(result.stderr).toContain("node が見つかりません");
  });
});

describe("ビルドした menou を bin/menou 経由で動かす", () => {
  beforeAll(() => {
    execFileSync(process.execPath, ["scripts/build.mjs"], { cwd: repoRoot });
  }, 60_000);

  function configure(repo: Repo, run: string) {
    repo.write(
      ".menou.json",
      JSON.stringify({ checks: [{ id: "lint", mode: "evidence", run, paths: ["src/**"] }] }),
    );
  }

  function menou(repo: Repo, args: string[]) {
    return spawnSync(wrapper, args, { cwd: repo.root, encoding: "utf8" });
  }

  it("menou run はチェックの出力をそのまま流し、不合格なら終了コード 1 で終わり、menou status に不合格と出る", () => {
    const repo = createRepo();
    onTestFinished(() => repo.cleanup());
    repo.write("src/a.ts", "a");

    configure(repo, "echo from-check; exit 1");

    const result = menou(repo, ["run", "lint"]);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("from-check");
    expect(menou(repo, ["status"]).stdout).toMatch(/lint\s+不合格/);
  });

  it("menou run に知らない id を渡すと、終了コード 3 で終わる", () => {
    const repo = createRepo();
    onTestFinished(() => repo.cleanup());
    repo.write("src/a.ts", "a");

    configure(repo, "exit 0");

    expect(menou(repo, ["run", "lnt"]).status).toBe(3);
  });

  it("menou run が Ctrl-C（SIGINT）を受けたら、チェックが起動したプロセスまで止めて、チェックが 0 で終わってもエラーとして終わる", async () => {
    const repo = createRepo();
    onTestFinished(() => repo.cleanup());
    repo.write("src/a.ts", "a");

    const pidFile = join(repo.root, "pid");
    configure(repo, `trap 'exit 0' INT; sleep 30 & echo $! > "${pidFile}"; wait`);

    const child = spawn(wrapper, ["run", "lint"], { cwd: repo.root, stdio: "ignore" });
    const exited = new Promise<number | null>((resolve) => child.on("exit", resolve));
    await vi.waitFor(() => expect(existsSync(pidFile)).toBe(true), { timeout: 5000 });
    const sleepPid = Number(readFileSync(pidFile, "utf8"));
    child.kill("SIGINT");

    expect(await exited).toBe(3);
    await vi.waitFor(() => expect(() => process.kill(sleepPid, 0)).toThrow(), { timeout: 2000 });
    expect(menou(repo, ["status"]).stdout).toMatch(/lint\s+エラー（シグナル SIGINT）/);
  }, 20_000);
});
