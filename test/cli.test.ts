import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { version } from "../package.json";
import { run } from "../src/cli";
import { loadConfig } from "../src/config";
import { computeFingerprints } from "../src/fingerprint";
import { readRecord, resolveLocations } from "../src/store";
import { createRepo, type Repo } from "./repo";

async function runCli(args: string[], cwd?: string) {
  let stdout = "";
  let stderr = "";
  const code = await run(args, {
    cwd,
    checkOutput: "ignore",
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
  });
  return { code, stdout, stderr };
}

describe("menou コマンド", () => {
  it("--version でパッケージの version を表示する", async () => {
    expect(await runCli(["--version"])).toEqual({
      code: 0,
      stdout: `${version}\n`,
      stderr: "",
    });
  });

  it("知らないサブコマンドは、menou 側の失敗として終了コード 3 で終わり、使えるサブコマンドを伝える", async () => {
    const { code, stderr } = await runCli(["unknown"]);

    expect(code).toBe(3);
    expect(stderr).toContain("unknown");
    expect(stderr).toContain("run, status");
  });

  it("サブコマンドを渡さなければ、終了コード 3 で終わる", async () => {
    expect((await runCli([])).code).toBe(3);
  });
});

let repo: Repo;

beforeEach(() => {
  repo = createRepo();
  repo.write("src/a.ts", "a");
  repo.write("README.md", "readme");
});

afterEach(() => {
  repo.cleanup();
});

function configure(checks: Record<string, unknown>[], root = repo.root) {
  writeFileSync(
    join(root, ".menou.json"),
    JSON.stringify({
      checks: checks.map((check) => ({ mode: "inline", paths: ["src/**"], ...check })),
    }),
  );
}

function currentFingerprint(id: string) {
  const config = loadConfig(repo.root);
  if (config.status !== "loaded") throw new Error(JSON.stringify(config));
  return computeFingerprints(repo.root, config.config.checks).fingerprints.get(id) ?? "";
}

function recordOf(id: string, fingerprint = currentFingerprint(id)) {
  return readRecord(resolveLocations(repo.root), id, fingerprint);
}

function recordFiles() {
  const dir = resolveLocations(repo.root).resultsDir;
  return existsSync(dir) ? readdirSync(dir, { recursive: true }) : [];
}

describe("menou run <id>", () => {
  it.each([
    ["合格（0）", 0, "exit 0", { result: "pass" }],
    ["不合格（1）", 1, "exit 1", { result: "fail" }],
    ["それ以外の終了コード", 3, "exit 4", { result: "error", cause: { kind: "exit", code: 4 } }],
    [
      "コマンドが見つからない",
      3,
      "menou-no-such-command",
      { result: "error", cause: { kind: "exit", code: 127 } },
    ],
    [
      "シグナルによる終了",
      3,
      "kill -TERM $$",
      { result: "error", cause: { kind: "signal", signal: "SIGTERM" } },
    ],
  ])(
    "%s は、終了コード %i で終わり、今のフィンガープリントとともに記録する",
    async (_, code, command, outcome) => {
      configure([{ id: "lint", run: command }]);

      expect((await runCli(["run", "lint"], repo.root)).code).toBe(code);
      expect(recordOf("lint")).toMatchObject({ id: "lint", ...outcome });
    },
  );

  it("inline 方式で timeout を過ぎたら、タイムアウトのエラーとして記録し、終了コード 3 で終わる", async () => {
    configure([{ id: "lint", run: "sleep 30", timeout: 1 }]);

    const { code, stderr } = await runCli(["run", "lint"], repo.root);

    expect(code).toBe(3);
    expect(stderr).toContain("timeout");
    expect(recordOf("lint")).toMatchObject({ result: "error", cause: { kind: "timeout" } });
  });

  it("実行中に paths の中のファイルが書き換わったら、合格でもエラーとして、実行する前のフィンガープリントで記録する", async () => {
    configure([{ id: "lint", run: "echo changed >> src/a.ts" }]);
    const before = currentFingerprint("lint");

    const { code, stderr } = await runCli(["run", "lint"], repo.root);

    expect(code).toBe(3);
    expect(stderr).toContain("書き換わりました");
    expect(recordOf("lint", before)).toMatchObject({
      result: "error",
      cause: { kind: "modified" },
    });
    expect(recordOf("lint")).toBeUndefined();
  });

  it("実行中に paths の外のファイルを書いても、終了コードどおりに記録する", async () => {
    configure([{ id: "lint", run: "echo log > lint.log" }]);

    expect((await runCli(["run", "lint"], repo.root)).code).toBe(0);
    expect(recordOf("lint")?.result).toBe("pass");
  });

  it("MENOU_OUT のディレクトリは、実行の前に空にする", async () => {
    configure([
      { id: "review", run: 'test ! -e "$MENOU_OUT/old.md" && echo new > "$MENOU_OUT/new.md"' },
    ]);
    await runCli(["run", "review"], repo.root);
    writeFileSync(join(resolveLocations(repo.root).worktreeDir, "out", "review", "old.md"), "old");

    expect((await runCli(["run", "review"], repo.root)).code).toBe(0);
  });

  it("同じフィンガープリントで合格した記録があっても、もう一度実行する", async () => {
    const counter = join(repo.root, "count.log");
    configure([{ id: "lint", run: `echo x >> "${counter}"` }]);

    await runCli(["run", "lint"], repo.root);
    await runCli(["run", "lint"], repo.root);

    expect(readFileSync(counter, "utf8")).toBe("x\nx\n");
  });

  it("サブディレクトリから実行しても、リポジトリのルートでチェックを実行する", async () => {
    configure([{ id: "lint", run: "test -f .menou.json" }]);
    mkdirSync(join(repo.root, "src", "sub"), { recursive: true });

    expect((await runCli(["run", "lint"], join(repo.root, "src", "sub"))).code).toBe(0);
  });

  describe("menou 側の失敗は、チェックを実行せず、記録も書かずに終了コード 3 で終わる", () => {
    it("id を渡さなければ、使い方と使える id を伝える", async () => {
      configure([
        { id: "lint", run: "exit 0" },
        { id: "e2e", run: "exit 0" },
      ]);

      const { code, stderr } = await runCli(["run"], repo.root);

      expect(code).toBe(3);
      expect(stderr).toContain("menou run <id>");
      expect(stderr).toContain("lint, e2e");
      expect(recordFiles()).toEqual([]);
    });

    it("知らない id なら、その id と使える id を伝える", async () => {
      configure([{ id: "lint", run: "exit 0" }]);

      const { code, stderr } = await runCli(["run", "lnt"], repo.root);

      expect(code).toBe(3);
      expect(stderr).toContain('"lnt"');
      expect(stderr).toContain("lint");
      expect(recordFiles()).toEqual([]);
    });

    it(".menou.json が不正なら、どこが不正かを伝える", async () => {
      configure([{ id: "lint", run: "exit 0", timout: 1 }]);

      const { code, stderr } = await runCli(["run", "lint"], repo.root);

      expect(code).toBe(3);
      expect(stderr).toContain("checks[0].timout");
      expect(recordFiles()).toEqual([]);
    });

    it(".menou.json がなければ、置くよう伝える", async () => {
      const { code, stderr } = await runCli(["run", "lint"], repo.root);

      expect(code).toBe(3);
      expect(stderr).toContain(".menou.json");
    });

    it("git リポジトリの外なら、リポジトリの中で実行するよう伝える", async () => {
      const outside = realpathSync(mkdtempSync(join(tmpdir(), "menou-outside-")));
      try {
        const { code, stderr } = await runCli(["run", "lint"], outside);

        expect(code).toBe(3);
        expect(stderr).toContain("git リポジトリ");
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    });
  });
});

describe("menou status", () => {
  it("まだ実行していないチェックは、記録なしと、取るためのコマンドを表示する", async () => {
    configure([{ id: "lint", run: "exit 0" }]);

    const { code, stdout } = await runCli(["status"], repo.root);

    expect(code).toBe(0);
    expect(stdout).toMatch(/lint\s+記録なし.*menou run lint/);
  });

  it("今のフィンガープリントの記録の合否を、チェックごとに表示する", async () => {
    configure([
      { id: "lint", run: "exit 0" },
      { id: "unit", run: "exit 1" },
      { id: "e2e", run: "exit 5", mode: "evidence" },
    ]);
    for (const id of ["lint", "unit", "e2e"]) await runCli(["run", id], repo.root);

    const { code, stdout } = await runCli(["status"], repo.root);

    expect(code).toBe(0);
    expect(stdout).toMatch(/lint\s+合格/);
    expect(stdout).toMatch(/unit\s+不合格/);
    expect(stdout).toMatch(/e2e\s+エラー（終了コード 5）/);
  });

  it("paths の中のファイルを変えると、記録なしに戻る", async () => {
    configure([{ id: "lint", run: "exit 0" }]);
    await runCli(["run", "lint"], repo.root);

    repo.write("src/a.ts", "changed");

    expect((await runCli(["status"], repo.root)).stdout).toMatch(/lint\s+記録なし/);
  });

  it("paths の外のファイルを変えても、記録はそのまま使う", async () => {
    configure([{ id: "lint", run: "exit 0" }]);
    await runCli(["run", "lint"], repo.root);

    repo.write("README.md", "changed");

    expect((await runCli(["status"], repo.root)).stdout).toMatch(/lint\s+合格/);
  });

  it("ある worktree で取った記録を、同じフィンガープリントの別の worktree でも使う", async () => {
    configure([{ id: "lint", run: "exit 0" }]);
    repo.commitAll();
    const worktree = `${repo.root}-wt`;
    repo.git("worktree", "add", "-q", worktree);
    try {
      await runCli(["run", "lint"], repo.root);

      expect((await runCli(["status"], worktree)).stdout).toMatch(/lint\s+合格/);
    } finally {
      repo.git("worktree", "remove", "--force", worktree);
    }
  });

  it("どのファイルにも一致しない paths があれば警告し、終了コードは 0 のまま", async () => {
    configure([{ id: "lint", run: "exit 0", paths: ["src/**", "lib/**"] }]);

    const { code, stderr } = await runCli(["status"], repo.root);

    expect(code).toBe(0);
    expect(stderr).toContain('lint の paths の "lib/**"');
    expect(stderr).not.toContain('"src/**"');
  });

  it("除外の paths は、除外するファイルがなくても警告しない", async () => {
    configure([{ id: "lint", run: "exit 0", paths: ["src/**", ":(exclude)lib/**"] }]);

    expect((await runCli(["status"], repo.root)).stderr).toBe("");
  });

  it(".menou.json が不正なら、どこが不正かを伝えて終了コード 3 で終わる", async () => {
    configure([{ id: "lint", run: "exit 0", timout: 1 }]);

    const { code, stderr } = await runCli(["status"], repo.root);

    expect(code).toBe(3);
    expect(stderr).toContain("checks[0].timout");
  });

  it(".menou.json がなければ、menou が何もしないことを伝えて終了コード 0 で終わる", async () => {
    const { code, stdout } = await runCli(["status"], repo.root);

    expect(code).toBe(0);
    expect(stdout).toContain(".menou.json");
  });
});
