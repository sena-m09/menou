import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect } from "vitest";
import { type Repo, testWithRepo } from "./repo";
import { testWithTempDir } from "./temp-dir";
import { isAlive, waitUntil } from "./wait";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const wrapper = join(repoRoot, "bin/menou");

const pathDirTest = testWithTempDir("menou-bin-");

function runWrapper(pathDir: string, args: string[]) {
  return spawnSync(wrapper, args, {
    env: { PATH: pathDir },
    encoding: "utf8",
  });
}

describe("bin/menou", () => {
  pathDirTest("node があれば、まとめた JS に引数をそのまま渡して実行する", ({ dir }) => {
    const fakeNode = join(dir, "node");
    writeFileSync(fakeNode, "#!/bin/sh\nprintf '%s\\n' \"$@\"\n");
    chmodSync(fakeNode, 0o755);

    const result = runWrapper(dir, ["run", "lint"]);

    expect(result.status).toBe(0);
    const [script, ...args] = result.stdout.trimEnd().split("\n");
    expect(resolve(script ?? "")).toBe(join(repoRoot, "dist/menou.cjs"));
    expect(args).toEqual(["run", "lint"]);
  });

  pathDirTest("node が PATH になければ、そのことを知らせて終了コード 127 で止まる", ({ dir }) => {
    const result = runWrapper(dir, ["run", "lint"]);

    expect(result.status).toBe(127);
    expect(result.stderr).toContain("node が見つかりません");
  });
});

describe("ビルドした menou を bin/menou 経由で動かす", () => {
  const repoTest = testWithRepo((repo) => repo.write("src/a.ts", "a"));

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

  repoTest(
    "menou run はチェックの出力をそのまま流し、不合格なら終了コード 1 で終わり、menou status に不合格と出る",
    ({ repo }) => {
      configure(repo, "echo from-check; exit 1");

      const result = menou(repo, ["run", "lint"]);

      expect(result.status).toBe(1);
      expect(result.stdout).toContain("from-check");
      expect(menou(repo, ["status"]).stdout).toMatch(/lint\s+不合格/);
    },
  );

  repoTest("menou run に知らない id を渡すと、終了コード 3 で終わる", ({ repo }) => {
    configure(repo, "exit 0");

    expect(menou(repo, ["run", "lnt"]).status).toBe(3);
  });

  repoTest(
    "menou run が Ctrl-C（SIGINT）を受けたら、チェックが起動したプロセスまで止めて、チェックが 0 で終わってもエラーとして終わる",
    async ({ repo }) => {
      const pidFile = join(repo.root, "pid");
      configure(repo, `trap 'exit 0' INT; sleep 30 & echo $! > "${pidFile}"; wait`);

      const child = spawn(wrapper, ["run", "lint"], { cwd: repo.root, stdio: "ignore" });
      const exited = new Promise<number | null>((resolve) => child.on("exit", resolve));
      await waitUntil(() => existsSync(pidFile), 5000);
      const sleepPid = Number(readFileSync(pidFile, "utf8"));
      child.kill("SIGINT");

      expect(await exited).toBe(3);
      expect(await waitUntil(() => !isAlive(sleepPid))).toBe(true);
      expect(menou(repo, ["status"]).stdout).toMatch(/lint\s+エラー（シグナル SIGINT）/);
    },
    20_000,
  );
});
