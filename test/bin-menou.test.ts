import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createRepo, type Repo } from "./repo";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const wrapper = join(repoRoot, "bin/menou");

let pathDir: string;

beforeEach(() => {
  pathDir = mkdtempSync(join(tmpdir(), "menou-bin-"));
});

afterEach(() => {
  rmSync(pathDir, { recursive: true, force: true });
});

function runWrapper(args: string[]) {
  return spawnSync(wrapper, args, {
    env: { PATH: pathDir },
    encoding: "utf8",
  });
}

describe("bin/menou", () => {
  it("node があれば、まとめた JS に引数をそのまま渡して実行する", () => {
    const fakeNode = join(pathDir, "node");
    writeFileSync(fakeNode, "#!/bin/sh\nprintf '%s\\n' \"$@\"\n");
    chmodSync(fakeNode, 0o755);

    const result = runWrapper(["run", "lint"]);

    expect(result.status).toBe(0);
    const [script, ...args] = result.stdout.trimEnd().split("\n");
    expect(resolve(script ?? "")).toBe(join(repoRoot, "dist/menou.cjs"));
    expect(args).toEqual(["run", "lint"]);
  });

  it("node が PATH になければ、そのことを知らせて終了コード 127 で止まる", () => {
    const result = runWrapper(["run", "lint"]);

    expect(result.status).toBe(127);
    expect(result.stderr).toContain("node が見つかりません");
  });
});

async function waitUntilGone(pid: number) {
  const alive = () => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  for (let i = 0; i < 40 && alive(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !alive();
}

describe("ビルドした menou を bin/menou 経由で動かす", () => {
  let repo: Repo;

  beforeAll(() => {
    execFileSync(process.execPath, ["scripts/build.mjs"], { cwd: repoRoot });
  }, 60_000);

  beforeEach(() => {
    repo = createRepo();
    repo.write("src/a.ts", "a");
  });

  afterEach(() => {
    repo.cleanup();
  });

  function configure(run: string) {
    repo.write(
      ".menou.json",
      JSON.stringify({ checks: [{ id: "lint", mode: "evidence", run, paths: ["src/**"] }] }),
    );
  }

  function menou(args: string[]) {
    return spawnSync(wrapper, args, { cwd: repo.root, encoding: "utf8" });
  }

  it("menou run はチェックの出力をそのまま流し、不合格なら終了コード 1 で終わり、menou status に不合格と出る", () => {
    configure("echo from-check; exit 1");

    const result = menou(["run", "lint"]);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("from-check");
    expect(menou(["status"]).stdout).toMatch(/lint\s+不合格/);
  });

  it("menou run に知らない id を渡すと、終了コード 3 で終わる", () => {
    configure("exit 0");

    expect(menou(["run", "lnt"]).status).toBe(3);
  });

  it("menou run が Ctrl-C（SIGINT）を受けたら、チェックが起動したプロセスまで止めて、チェックが 0 で終わってもエラーとして終わる", async () => {
    const pidFile = join(repo.root, "pid");
    configure(`trap 'exit 0' INT; sleep 30 & echo $! > "${pidFile}"; wait`);

    const child = spawn(wrapper, ["run", "lint"], { cwd: repo.root, stdio: "ignore" });
    const exited = new Promise<number | null>((resolve) => child.on("exit", resolve));
    for (let i = 0; i < 100 && !existsSync(pidFile); i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const sleepPid = Number(readFileSync(pidFile, "utf8"));
    child.kill("SIGINT");

    expect(await exited).toBe(3);
    expect(await waitUntilGone(sleepPid)).toBe(true);
    expect(menou(["status"]).stdout).toMatch(/lint\s+エラー（シグナル SIGINT）/);
  }, 20_000);
});
