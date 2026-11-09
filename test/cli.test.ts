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
import type { JsonValue } from "fast-check";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { version } from "../package.json";
import { run } from "../src/cli";
import { loadConfig } from "../src/config";
import { computeFingerprints } from "../src/fingerprint";
import { takeSnapshot } from "../src/snapshot";
import { readRecord, resolveLocations } from "../src/store";
import { createRepo, type Repo } from "./repo";

async function runCli(
  args: string[],
  cwd?: string,
  { stdin = "", env = {} }: { stdin?: string; env?: NodeJS.ProcessEnv } = {},
) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await run(args, {
    cwd,
    env,
    readStdin: () => Promise.resolve(stdin),
    checkOutput: "ignore",
    stdout: (text) => {
      stdout.push(text);
    },
    stderr: (text) => {
      stderr.push(text);
    },
  });
  return { code, stdout: stdout.join(""), stderr: stderr.join("") };
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

function configure(repo: Repo, checks: { [key: string]: JsonValue }[]) {
  writeFileSync(
    join(repo.root, ".menou.json"),
    JSON.stringify({
      checks: checks.map((check) => ({ mode: "inline", paths: ["src/**"], ...check })),
    }),
  );
}

function currentFingerprint(repo: Repo, id: string) {
  const config = loadConfig(repo.root);
  if (config.status !== "loaded") throw new Error(JSON.stringify(config));
  return computeFingerprints(repo.root, config.config.checks).fingerprints.get(id) ?? "";
}

function recordOf(repo: Repo, id: string, fingerprint = currentFingerprint(repo, id)) {
  return readRecord(resolveLocations(repo.root), id, fingerprint);
}

function recordFiles(repo: Repo) {
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
      const repo = createRepo();
      onTestFinished(() => repo.cleanup());
      repo.write("src/a.ts", "a");
      repo.write("README.md", "readme");

      configure(repo, [{ id: "lint", run: command }]);

      expect((await runCli(["run", "lint"], repo.root)).code).toBe(code);
      expect(recordOf(repo, "lint")).toMatchObject({ id: "lint", ...outcome });
    },
  );

  it("inline 方式で timeout を過ぎたら、タイムアウトのエラーとして記録し、終了コード 3 で終わる", async () => {
    const repo = createRepo();
    onTestFinished(() => repo.cleanup());
    repo.write("src/a.ts", "a");
    repo.write("README.md", "readme");

    configure(repo, [{ id: "lint", run: "sleep 30", timeout: 1 }]);

    const { code, stderr } = await runCli(["run", "lint"], repo.root);

    expect(code).toBe(3);
    expect(stderr).toContain("timeout");
    expect(recordOf(repo, "lint")).toMatchObject({ result: "error", cause: { kind: "timeout" } });
  });

  it("実行中に paths の中のファイルが書き換わったら、合格でもエラーとして、実行する前のフィンガープリントで記録する", async () => {
    const repo = createRepo();
    onTestFinished(() => repo.cleanup());
    repo.write("src/a.ts", "a");
    repo.write("README.md", "readme");

    configure(repo, [{ id: "lint", run: "echo changed >> src/a.ts" }]);
    const before = currentFingerprint(repo, "lint");

    const { code, stderr } = await runCli(["run", "lint"], repo.root);

    expect(code).toBe(3);
    expect(stderr).toContain("書き換わりました");
    expect(recordOf(repo, "lint", before)).toMatchObject({
      result: "error",
      cause: { kind: "modified" },
    });
    expect(recordOf(repo, "lint")).toBeUndefined();
  });

  it("実行中に paths の外のファイルを書いても、終了コードどおりに記録する", async () => {
    const repo = createRepo();
    onTestFinished(() => repo.cleanup());
    repo.write("src/a.ts", "a");
    repo.write("README.md", "readme");

    configure(repo, [{ id: "lint", run: "echo log > lint.log" }]);

    expect((await runCli(["run", "lint"], repo.root)).code).toBe(0);
    expect(recordOf(repo, "lint")?.result).toBe("pass");
  });

  it("MENOU_OUT のディレクトリは、実行の前に空にする", async () => {
    const repo = createRepo();
    onTestFinished(() => repo.cleanup());
    repo.write("src/a.ts", "a");
    repo.write("README.md", "readme");

    configure(repo, [
      { id: "review", run: 'test ! -e "$MENOU_OUT/old.md" && echo new > "$MENOU_OUT/new.md"' },
    ]);
    await runCli(["run", "review"], repo.root);
    writeFileSync(join(resolveLocations(repo.root).worktreeDir, "out", "review", "old.md"), "old");

    expect((await runCli(["run", "review"], repo.root)).code).toBe(0);
  });

  it("記録に、実行した worktree の git ディレクトリを残す", async () => {
    const repo = createRepo();
    onTestFinished(() => repo.cleanup());
    repo.write("src/a.ts", "a");

    configure(repo, [{ id: "lint", run: "exit 1" }]);
    repo.commitAll();
    const worktree = `${repo.root}-wt`;
    repo.git("worktree", "add", "-q", worktree);
    onTestFinished(() => {
      repo.git("worktree", "remove", "--force", worktree);
    });

    await runCli(["run", "lint"], worktree);

    expect(recordOf(repo, "lint")).toMatchObject({
      result: "fail",
      gitDir: resolveLocations(worktree).gitDir,
    });
  });

  it("同じフィンガープリントで合格した記録があっても、もう一度実行する", async () => {
    const repo = createRepo();
    onTestFinished(() => repo.cleanup());
    repo.write("src/a.ts", "a");
    repo.write("README.md", "readme");

    const counter = join(repo.root, "count.log");
    configure(repo, [{ id: "lint", run: `echo x >> "${counter}"` }]);

    await runCli(["run", "lint"], repo.root);
    await runCli(["run", "lint"], repo.root);

    expect(readFileSync(counter, "utf8")).toBe("x\nx\n");
  });

  it("サブディレクトリから実行しても、リポジトリのルートでチェックを実行する", async () => {
    const repo = createRepo();
    onTestFinished(() => repo.cleanup());
    repo.write("src/a.ts", "a");
    repo.write("README.md", "readme");

    configure(repo, [{ id: "lint", run: "test -f .menou.json" }]);
    mkdirSync(join(repo.root, "src", "sub"), { recursive: true });

    expect((await runCli(["run", "lint"], join(repo.root, "src", "sub"))).code).toBe(0);
  });

  describe("menou 側の失敗は、チェックを実行せず、記録も書かずに終了コード 3 で終わる", () => {
    it("id を渡さなければ、使い方と使える id を伝える", async () => {
      const repo = createRepo();
      onTestFinished(() => repo.cleanup());
      repo.write("src/a.ts", "a");
      repo.write("README.md", "readme");

      configure(repo, [
        { id: "lint", run: "exit 0" },
        { id: "e2e", run: "exit 0" },
      ]);

      const { code, stderr } = await runCli(["run"], repo.root);

      expect(code).toBe(3);
      expect(stderr).toContain("menou run <id>");
      expect(stderr).toContain("lint, e2e");
      expect(recordFiles(repo)).toEqual([]);
    });

    it("知らない id なら、その id と使える id を伝える", async () => {
      const repo = createRepo();
      onTestFinished(() => repo.cleanup());
      repo.write("src/a.ts", "a");
      repo.write("README.md", "readme");

      configure(repo, [{ id: "lint", run: "exit 0" }]);

      const { code, stderr } = await runCli(["run", "lnt"], repo.root);

      expect(code).toBe(3);
      expect(stderr).toContain('"lnt"');
      expect(stderr).toContain("lint");
      expect(recordFiles(repo)).toEqual([]);
    });

    it(".menou.json が不正なら、どこが不正かを伝える", async () => {
      const repo = createRepo();
      onTestFinished(() => repo.cleanup());
      repo.write("src/a.ts", "a");
      repo.write("README.md", "readme");

      configure(repo, [{ id: "lint", run: "exit 0", timout: 1 }]);

      const { code, stderr } = await runCli(["run", "lint"], repo.root);

      expect(code).toBe(3);
      expect(stderr).toContain("checks[0].timout");
      expect(recordFiles(repo)).toEqual([]);
    });

    it(".menou.json がなければ、置くよう伝える", async () => {
      const repo = createRepo();
      onTestFinished(() => repo.cleanup());
      repo.write("src/a.ts", "a");
      repo.write("README.md", "readme");

      const { code, stderr } = await runCli(["run", "lint"], repo.root);

      expect(code).toBe(3);
      expect(stderr).toContain(".menou.json");
    });

    it("git リポジトリの外なら、リポジトリの中で実行するよう伝える", async () => {
      const dir = realpathSync(mkdtempSync(join(tmpdir(), "menou-outside-")));
      onTestFinished(() => rmSync(dir, { recursive: true, force: true }));

      const { code, stderr } = await runCli(["run", "lint"], dir);

      expect(code).toBe(3);
      expect(stderr).toContain("git リポジトリ");
    });
  });
});

describe("menou status", () => {
  it("まだ実行していないチェックは、記録なしと、取るためのコマンドを表示する", async () => {
    const repo = createRepo();
    onTestFinished(() => repo.cleanup());
    repo.write("src/a.ts", "a");
    repo.write("README.md", "readme");

    configure(repo, [{ id: "lint", run: "exit 0" }]);

    const { code, stdout } = await runCli(["status"], repo.root);

    expect(code).toBe(0);
    expect(stdout).toMatch(/lint\s+記録なし.*menou run lint/);
  });

  it("今のフィンガープリントの記録の合否を、チェックごとに表示する", async () => {
    const repo = createRepo();
    onTestFinished(() => repo.cleanup());
    repo.write("src/a.ts", "a");
    repo.write("README.md", "readme");

    configure(repo, [
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
    const repo = createRepo();
    onTestFinished(() => repo.cleanup());
    repo.write("src/a.ts", "a");
    repo.write("README.md", "readme");

    configure(repo, [{ id: "lint", run: "exit 0" }]);
    await runCli(["run", "lint"], repo.root);

    repo.write("src/a.ts", "changed");

    expect((await runCli(["status"], repo.root)).stdout).toMatch(/lint\s+記録なし/);
  });

  it("paths の外のファイルを変えても、記録はそのまま使う", async () => {
    const repo = createRepo();
    onTestFinished(() => repo.cleanup());
    repo.write("src/a.ts", "a");
    repo.write("README.md", "readme");

    configure(repo, [{ id: "lint", run: "exit 0" }]);
    await runCli(["run", "lint"], repo.root);

    repo.write("README.md", "changed");

    expect((await runCli(["status"], repo.root)).stdout).toMatch(/lint\s+合格/);
  });

  it("ある worktree で取った記録を、同じフィンガープリントの別の worktree でも使う", async () => {
    const repo = createRepo();
    onTestFinished(() => repo.cleanup());
    repo.write("src/a.ts", "a");
    repo.write("README.md", "readme");

    configure(repo, [{ id: "lint", run: "exit 0" }]);
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
    const repo = createRepo();
    onTestFinished(() => repo.cleanup());
    repo.write("src/a.ts", "a");
    repo.write("README.md", "readme");

    configure(repo, [{ id: "lint", run: "exit 0", paths: ["src/**", "lib/**"] }]);

    const { code, stderr } = await runCli(["status"], repo.root);

    expect(code).toBe(0);
    expect(stderr).toContain('lint の paths の "lib/**"');
    expect(stderr).not.toContain('"src/**"');
  });

  it("除外の paths は、除外するファイルがなくても警告しない", async () => {
    const repo = createRepo();
    onTestFinished(() => repo.cleanup());
    repo.write("src/a.ts", "a");
    repo.write("README.md", "readme");

    configure(repo, [{ id: "lint", run: "exit 0", paths: ["src/**", ":(exclude)lib/**"] }]);

    expect((await runCli(["status"], repo.root)).stderr).toBe("");
  });

  it(".menou.json が不正なら、どこが不正かを伝えて終了コード 3 で終わる", async () => {
    const repo = createRepo();
    onTestFinished(() => repo.cleanup());
    repo.write("src/a.ts", "a");
    repo.write("README.md", "readme");

    configure(repo, [{ id: "lint", run: "exit 0", timout: 1 }]);

    const { code, stderr } = await runCli(["status"], repo.root);

    expect(code).toBe(3);
    expect(stderr).toContain("checks[0].timout");
  });

  it(".menou.json がなければ、menou が何もしないことを伝えて終了コード 0 で終わる", async () => {
    const repo = createRepo();
    onTestFinished(() => repo.cleanup());
    repo.write("src/a.ts", "a");
    repo.write("README.md", "readme");

    const { code, stdout } = await runCli(["status"], repo.root);

    expect(code).toBe(0);
    expect(stdout).toContain(".menou.json");
  });
});

describe("menou hook session-start", () => {
  it("記録したベースラインを、同じセッションの menou run が MENOU_BASELINE として渡し、標準出力には何も出さない", async () => {
    const repo = createRepo();
    onTestFinished(() => repo.cleanup());
    repo.write("src/a.ts", "a");
    configure(repo, [{ id: "baseline", run: "printenv MENOU_BASELINE > baseline.txt" }]);
    const tree = takeSnapshot(repo.root, []).tree;

    const started = await runCli(["hook", "session-start"], repo.root, {
      stdin: JSON.stringify({
        session_id: "session-a",
        transcript_path: "/tmp/transcript.jsonl",
        cwd: repo.root,
        hook_event_name: "SessionStart",
        source: "startup",
      }),
    });

    expect(started).toEqual({ code: 0, stdout: "", stderr: "" });
    await runCli(["run", "baseline"], repo.root, { env: { CLAUDE_CODE_SESSION_ID: "session-a" } });
    expect(readFileSync(join(repo.root, "baseline.txt"), "utf8")).toBe(`${tree}\n`);
  });

  it("同じセッション ID でもう一度呼ばれても、作業ツリーを変えたあとでも、最初のベースラインのまま", async () => {
    const repo = createRepo();
    onTestFinished(() => repo.cleanup());
    repo.write("src/a.ts", "a");
    configure(repo, [{ id: "baseline", run: "printenv MENOU_BASELINE > baseline.txt" }]);
    const first = takeSnapshot(repo.root, []).tree;
    await runCli(["hook", "session-start"], repo.root, {
      stdin: JSON.stringify({ session_id: "session-a", source: "startup" }),
    });

    repo.write("src/a.ts", "changed");
    const resumed = await runCli(["hook", "session-start"], repo.root, {
      stdin: JSON.stringify({ session_id: "session-a", source: "resume" }),
    });
    repo.write("src/b.ts", "b");
    await runCli(["hook", "session-start"], repo.root, {
      stdin: JSON.stringify({ session_id: "session-a", source: "compact" }),
    });

    expect(resumed).toEqual({ code: 0, stdout: "", stderr: "" });
    await runCli(["run", "baseline"], repo.root, { env: { CLAUDE_CODE_SESSION_ID: "session-a" } });
    expect(readFileSync(join(repo.root, "baseline.txt"), "utf8")).toBe(`${first}\n`);
  });

  it("別のセッション ID なら、その時点の作業ツリーを別のベースラインとして記録する", async () => {
    const repo = createRepo();
    onTestFinished(() => repo.cleanup());
    repo.write("src/a.ts", "a");
    configure(repo, [{ id: "baseline", run: "printenv MENOU_BASELINE > baseline.txt" }]);
    const treeOfA = takeSnapshot(repo.root, []).tree;
    await runCli(["hook", "session-start"], repo.root, {
      stdin: JSON.stringify({ session_id: "session-a", source: "startup" }),
    });

    repo.write("src/a.ts", "changed");
    const treeOfB = takeSnapshot(repo.root, []).tree;
    await runCli(["hook", "session-start"], repo.root, {
      stdin: JSON.stringify({ session_id: "session-b", source: "clear" }),
    });

    await runCli(["run", "baseline"], repo.root, { env: { CLAUDE_CODE_SESSION_ID: "session-a" } });
    expect(readFileSync(join(repo.root, "baseline.txt"), "utf8")).toBe(`${treeOfA}\n`);
    await runCli(["run", "baseline"], repo.root, { env: { CLAUDE_CODE_SESSION_ID: "session-b" } });
    expect(readFileSync(join(repo.root, "baseline.txt"), "utf8")).toBe(`${treeOfB}\n`);
    expect(treeOfA).not.toBe(treeOfB);
  });

  it(".menou.json が不正でも、ベースラインを記録して終了コード 0 で終わる", async () => {
    const repo = createRepo();
    onTestFinished(() => repo.cleanup());
    repo.write("src/a.ts", "a");
    configure(repo, [{ id: "lint", run: "exit 0", timout: 1 }]);

    const started = await runCli(["hook", "session-start"], repo.root, {
      stdin: JSON.stringify({ session_id: "session-a", source: "startup" }),
    });

    expect(started).toEqual({ code: 0, stdout: "", stderr: "" });
    expect(readdirSync(join(resolveLocations(repo.root).worktreeDir, "sessions"))).toEqual([
      "session-a",
    ]);
  });

  it(".menou.json がなければ、何も書かず、何も出さずに終了コード 0 で終わる", async () => {
    const repo = createRepo();
    onTestFinished(() => repo.cleanup());
    repo.write("src/a.ts", "a");

    const started = await runCli(["hook", "session-start"], repo.root, {
      stdin: JSON.stringify({ session_id: "session-a", source: "startup" }),
    });

    expect(started).toEqual({ code: 0, stdout: "", stderr: "" });
    expect(existsSync(resolveLocations(repo.root).worktreeDir)).toBe(false);
  });

  it("MENOU_DISABLED=1 なら、何も書かず、何も出さずに終了コード 0 で終わる", async () => {
    const repo = createRepo();
    onTestFinished(() => repo.cleanup());
    repo.write("src/a.ts", "a");
    configure(repo, [{ id: "lint", run: "exit 0" }]);

    const started = await runCli(["hook", "session-start"], repo.root, {
      stdin: JSON.stringify({ session_id: "session-a", source: "startup" }),
      env: { MENOU_DISABLED: "1" },
    });

    expect(started).toEqual({ code: 0, stdout: "", stderr: "" });
    expect(existsSync(resolveLocations(repo.root).worktreeDir)).toBe(false);
  });

  it("git リポジトリの外なら、何も書かず、何も出さずに終了コード 0 で終わる", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "menou-outside-")));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, ".menou.json"), JSON.stringify({ checks: [] }));

    const started = await runCli(["hook", "session-start"], dir, {
      stdin: JSON.stringify({ session_id: "session-a", source: "startup" }),
    });

    expect(started).toEqual({ code: 0, stdout: "", stderr: "" });
    expect(readdirSync(dir)).toEqual([".menou.json"]);
  });

  it.each([
    ["JSON として読めない", "session_id=session-a", "JSON"],
    ["session_id がない", JSON.stringify({ source: "startup" }), "session_id"],
    ["session_id が文字列でない", JSON.stringify({ session_id: 1 }), "session_id"],
    ["session_id が空", JSON.stringify({ session_id: "" }), "session_id"],
    ["session_id が .", JSON.stringify({ session_id: "." }), '"."'],
    ["session_id が ..", JSON.stringify({ session_id: ".." }), '".."'],
    ["session_id が / を含む", JSON.stringify({ session_id: "../outside" }), '"../outside"'],
  ])(
    "入力が %s なら、何も書かず、標準出力にも出さず、理由を伝えて終了コード 3 で終わる",
    async (_, stdin, reason) => {
      const repo = createRepo();
      onTestFinished(() => repo.cleanup());
      repo.write("src/a.ts", "a");
      configure(repo, [{ id: "lint", run: "exit 0" }]);

      const { code, stdout, stderr } = await runCli(["hook", "session-start"], repo.root, {
        stdin,
      });

      expect(code).toBe(3);
      expect(stdout).toBe("");
      expect(stderr).toContain(reason);
      expect(existsSync(resolveLocations(repo.root).worktreeDir)).toBe(false);
    },
  );
});

describe("menou run が渡す MENOU_BASELINE", () => {
  it("その worktree にベースラインが 1 つもなければ、渡さない", async () => {
    const repo = createRepo();
    onTestFinished(() => repo.cleanup());
    repo.write("src/a.ts", "a");
    configure(repo, [{ id: "baseline", run: "printenv MENOU_BASELINE > baseline.txt" }]);

    await runCli(["run", "baseline"], repo.root, { env: { CLAUDE_CODE_SESSION_ID: "session-a" } });

    expect(readFileSync(join(repo.root, "baseline.txt"), "utf8")).toBe("");
  });

  it("CLAUDE_CODE_SESSION_ID のセッションのベースラインがあれば、後から記録された別のセッションより優先して渡す", async () => {
    const repo = createRepo();
    onTestFinished(() => repo.cleanup());
    repo.write("src/a.ts", "a");
    configure(repo, [{ id: "baseline", run: "printenv MENOU_BASELINE > baseline.txt" }]);
    vi.useFakeTimers({ toFake: ["Date"] });
    onTestFinished(() => {
      vi.useRealTimers();
    });

    vi.setSystemTime(new Date("2026-11-01T00:00:00Z"));
    const treeOfA = takeSnapshot(repo.root, []).tree;
    await runCli(["hook", "session-start"], repo.root, {
      stdin: JSON.stringify({ session_id: "session-a", source: "startup" }),
    });
    vi.setSystemTime(new Date("2026-11-02T00:00:00Z"));
    repo.write("src/a.ts", "changed");
    await runCli(["hook", "session-start"], repo.root, {
      stdin: JSON.stringify({ session_id: "session-b", source: "startup" }),
    });

    await runCli(["run", "baseline"], repo.root, { env: { CLAUDE_CODE_SESSION_ID: "session-a" } });

    expect(readFileSync(join(repo.root, "baseline.txt"), "utf8")).toBe(`${treeOfA}\n`);
  });

  it.each([
    ["CLAUDE_CODE_SESSION_ID が渡っていない", {}],
    [
      "CLAUDE_CODE_SESSION_ID のセッションのベースラインがない",
      { CLAUDE_CODE_SESSION_ID: "session-c" },
    ],
    [
      "CLAUDE_CODE_SESSION_ID がディレクトリ名に使えない値",
      { CLAUDE_CODE_SESSION_ID: "../session-a" },
    ],
  ])(
    "%s なら、記録した順ではなく記録した時刻で、最後に記録されたベースラインを渡す",
    async (_, env) => {
      const repo = createRepo();
      onTestFinished(() => repo.cleanup());
      repo.write("src/a.ts", "a");
      configure(repo, [{ id: "baseline", run: "printenv MENOU_BASELINE > baseline.txt" }]);
      vi.useFakeTimers({ toFake: ["Date"] });
      onTestFinished(() => {
        vi.useRealTimers();
      });

      vi.setSystemTime(new Date("2026-11-02T00:00:00Z"));
      const treeOfLatest = takeSnapshot(repo.root, []).tree;
      await runCli(["hook", "session-start"], repo.root, {
        stdin: JSON.stringify({ session_id: "session-latest", source: "startup" }),
      });
      vi.setSystemTime(new Date("2026-11-01T00:00:00Z"));
      repo.write("src/a.ts", "changed");
      await runCli(["hook", "session-start"], repo.root, {
        stdin: JSON.stringify({ session_id: "session-earlier", source: "startup" }),
      });

      await runCli(["run", "baseline"], repo.root, { env });

      expect(readFileSync(join(repo.root, "baseline.txt"), "utf8")).toBe(`${treeOfLatest}\n`);
    },
  );

  it("ほかの worktree で記録されたベースラインは使わない", async () => {
    const repo = createRepo();
    onTestFinished(() => repo.cleanup());
    repo.write("src/a.ts", "a");
    configure(repo, [{ id: "baseline", run: "printenv MENOU_BASELINE > baseline.txt" }]);
    repo.commitAll();
    const worktree = `${repo.root}-wt`;
    repo.git("worktree", "add", "-q", worktree);
    onTestFinished(() => {
      repo.git("worktree", "remove", "--force", worktree);
    });

    await runCli(["hook", "session-start"], repo.root, {
      stdin: JSON.stringify({ session_id: "session-a", source: "startup" }),
    });
    await runCli(["run", "baseline"], worktree, { env: { CLAUDE_CODE_SESSION_ID: "session-a" } });

    expect(readFileSync(join(worktree, "baseline.txt"), "utf8")).toBe("");
  });
});

describe("menou hook stop", () => {
  it("MENOU_DISABLED=1 なら、標準出力に {} だけを出して終了コード 0 で終わる", async () => {
    const repo = createRepo();
    onTestFinished(() => repo.cleanup());
    repo.write("src/a.ts", "a");
    repo.write(
      ".menou.json",
      JSON.stringify({
        checks: [{ id: "lint", mode: "inline", run: "exit 1", paths: ["src/**"] }],
      }),
    );

    const { code, stdout } = await runCli(["hook", "stop"], repo.root, {
      stdin: JSON.stringify({ session_id: "session-a", prompt_id: "prompt-1" }),
      env: { MENOU_DISABLED: "1" },
    });

    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual({});
  });

  it("git リポジトリの外なら、標準出力に {} だけを出して終了コード 0 で終わる", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "menou-outside-")));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(
      join(dir, ".menou.json"),
      JSON.stringify({ checks: [{ id: "lint", mode: "inline", run: "exit 1", paths: ["**"] }] }),
    );

    const { code, stdout } = await runCli(["hook", "stop"], dir, {
      stdin: JSON.stringify({ session_id: "session-a", prompt_id: "prompt-1" }),
    });

    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual({});
    expect(readdirSync(dir)).toEqual([".menou.json"]);
  });

  it(".menou.json がなければ、標準出力に {} だけを出して終了コード 0 で終わる", async () => {
    const repo = createRepo();
    onTestFinished(() => repo.cleanup());
    repo.write("src/a.ts", "a");

    const { code, stdout } = await runCli(["hook", "stop"], repo.root, {
      stdin: JSON.stringify({ session_id: "session-a", prompt_id: "prompt-1" }),
    });

    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual({});
    expect(existsSync(resolveLocations(repo.root).worktreeDir)).toBe(false);
  });

  it("作業ツリーがベースラインから変わっていなければ、満たしていないチェックがあっても {} を出す", async () => {
    const repo = createRepo();
    onTestFinished(() => repo.cleanup());
    repo.write("src/a.ts", "a");
    repo.write(
      ".menou.json",
      JSON.stringify({
        checks: [{ id: "lint", mode: "inline", run: "exit 1", paths: ["src/**"] }],
      }),
    );
    await runCli(["hook", "session-start"], repo.root, {
      stdin: JSON.stringify({ session_id: "session-a", source: "startup" }),
    });

    const { code, stdout } = await runCli(["hook", "stop"], repo.root, {
      stdin: JSON.stringify({
        session_id: "session-a",
        hook_event_name: "Stop",
        prompt_id: "prompt-1",
        stop_hook_active: false,
      }),
    });

    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual({});
  });

  it("ベースラインから変わっていても、すべてのチェックを満たしていれば {} を出す", async () => {
    const repo = createRepo();
    onTestFinished(() => repo.cleanup());
    repo.write("src/a.ts", "a");
    repo.write(
      ".menou.json",
      JSON.stringify({
        checks: [{ id: "lint", mode: "inline", run: "exit 0", paths: ["src/**"] }],
      }),
    );
    await runCli(["hook", "session-start"], repo.root, {
      stdin: JSON.stringify({ session_id: "session-a", source: "startup" }),
    });
    repo.write("src/a.ts", "changed");

    const { code, stdout } = await runCli(["hook", "stop"], repo.root, {
      stdin: JSON.stringify({ session_id: "session-a", prompt_id: "prompt-1" }),
    });

    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual({});
  });

  it("満たしていない block のチェックがあれば、decision を block にし、reason に実行するコマンドを書く", async () => {
    const repo = createRepo();
    onTestFinished(() => repo.cleanup());
    repo.write("src/a.ts", "a");
    repo.write(
      ".menou.json",
      JSON.stringify({
        checks: [{ id: "lint", mode: "inline", run: "exit 1", paths: ["src/**"] }],
      }),
    );
    await runCli(["hook", "session-start"], repo.root, {
      stdin: JSON.stringify({ session_id: "session-a", source: "startup" }),
    });
    repo.write("src/a.ts", "changed");

    const { code, stdout } = await runCli(["hook", "stop"], repo.root, {
      stdin: JSON.stringify({
        session_id: "session-a",
        transcript_path: "/tmp/transcript.jsonl",
        cwd: repo.root,
        permission_mode: "default",
        hook_event_name: "Stop",
        prompt_id: "prompt-1",
        stop_hook_active: false,
        last_assistant_message: "終わりました。",
      }),
    });

    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual({
      decision: "block",
      reason: expect.stringContaining("`menou run lint`"),
    });
  });

  it("ブロックするときに満たしていない warn のチェックもあれば、それを systemMessage で知らせる", async () => {
    const repo = createRepo();
    onTestFinished(() => repo.cleanup());
    repo.write("src/a.ts", "a");
    repo.write(
      ".menou.json",
      JSON.stringify({
        checks: [
          { id: "lint", mode: "inline", run: "exit 1", paths: ["src/**"] },
          { id: "style", mode: "inline", run: "exit 1", paths: ["src/**"], severity: "warn" },
        ],
      }),
    );

    const { code, stdout } = await runCli(["hook", "stop"], repo.root, {
      stdin: JSON.stringify({ session_id: "session-a", prompt_id: "prompt-1" }),
    });

    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual({
      decision: "block",
      reason: expect.not.stringContaining("style"),
      systemMessage: expect.stringContaining("`menou run style`"),
    });
  });

  it("満たしていないのが warn のチェックだけなら、ブロックせず systemMessage で知らせる", async () => {
    const repo = createRepo();
    onTestFinished(() => repo.cleanup());
    repo.write("src/a.ts", "a");
    repo.write(
      ".menou.json",
      JSON.stringify({
        checks: [
          { id: "lint", mode: "inline", run: "exit 0", paths: ["src/**"] },
          { id: "style", mode: "inline", run: "exit 1", paths: ["src/**"], severity: "warn" },
        ],
      }),
    );

    const { code, stdout } = await runCli(["hook", "stop"], repo.root, {
      stdin: JSON.stringify({ session_id: "session-a", prompt_id: "prompt-1" }),
    });

    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual({
      systemMessage: expect.stringContaining("`menou run style`"),
    });
  });

  it("同じ prompt_id で maxBlocks 回ブロックしたら、次は systemMessage で知らせて通し、prompt_id が変わればまたブロックする", async () => {
    const repo = createRepo();
    onTestFinished(() => repo.cleanup());
    repo.write("src/a.ts", "a");
    repo.write(
      ".menou.json",
      JSON.stringify({
        maxBlocks: 2,
        checks: [{ id: "lint", mode: "inline", run: "exit 1", paths: ["src/**"] }],
      }),
    );

    const outputs = [];
    for (const [promptId, active] of [
      ["prompt-1", false],
      ["prompt-1", true],
      ["prompt-1", true],
      ["prompt-2", false],
    ] as const) {
      const { code, stdout } = await runCli(["hook", "stop"], repo.root, {
        stdin: JSON.stringify({
          session_id: "session-a",
          hook_event_name: "Stop",
          prompt_id: promptId,
          stop_hook_active: active,
        }),
      });
      expect(code).toBe(0);
      outputs.push(JSON.parse(stdout));
    }

    expect(outputs).toEqual([
      { decision: "block", reason: expect.stringContaining("`menou run lint`") },
      { decision: "block", reason: expect.stringContaining("`menou run lint`") },
      { systemMessage: expect.stringContaining("2 回続けてブロックした") },
      { decision: "block", reason: expect.stringContaining("`menou run lint`") },
    ]);
  });

  it.each([
    ["ない", {}],
    ["文字列でない", { prompt_id: 1 }],
  ])(
    "prompt_id が %s ときも判定し、続けてブロックした回数で maxBlocks に達したら systemMessage で知らせて通す",
    async (_, promptId) => {
      const repo = createRepo();
      onTestFinished(() => repo.cleanup());
      repo.write("src/a.ts", "a");
      repo.write(
        ".menou.json",
        JSON.stringify({
          maxBlocks: 1,
          checks: [{ id: "lint", mode: "inline", run: "exit 1", paths: ["src/**"] }],
        }),
      );

      const first = await runCli(["hook", "stop"], repo.root, {
        stdin: JSON.stringify({ session_id: "session-a", ...promptId }),
      });
      const second = await runCli(["hook", "stop"], repo.root, {
        stdin: JSON.stringify({ session_id: "session-a", ...promptId }),
      });

      expect([first.code, second.code]).toEqual([0, 0]);
      expect(JSON.parse(first.stdout)).toEqual({
        decision: "block",
        reason: expect.stringContaining("`menou run lint`"),
      });
      expect(JSON.parse(second.stdout)).toEqual({
        systemMessage: expect.stringContaining("1 回続けてブロックした"),
      });
    },
  );

  it(".menou.json が不正なら、decision を block にし、reason に不正な箇所を書く", async () => {
    const repo = createRepo();
    onTestFinished(() => repo.cleanup());
    repo.write("src/a.ts", "a");
    repo.write(
      ".menou.json",
      JSON.stringify({
        checks: [{ id: "lint", mode: "inline", run: "exit 0", paths: ["src/**"], timout: 1 }],
      }),
    );

    const { code, stdout } = await runCli(["hook", "stop"], repo.root, {
      stdin: JSON.stringify({ session_id: "session-a", prompt_id: "prompt-1" }),
    });

    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual({
      decision: "block",
      reason: expect.stringContaining("checks[0].timout"),
    });
  });

  it.each([
    ["JSON として読めない", "session_id=session-a", "JSON"],
    ["session_id がない", JSON.stringify({ prompt_id: "prompt-1" }), "session_id"],
    ["session_id が文字列でない", JSON.stringify({ session_id: 1 }), "session_id"],
  ])(
    "入力が %s なら、何も書かず、ゲートが働かなかったことと原因を systemMessage で知らせて通す",
    async (_, stdin, cause) => {
      const repo = createRepo();
      onTestFinished(() => repo.cleanup());
      repo.write("src/a.ts", "a");
      repo.write(
        ".menou.json",
        JSON.stringify({
          checks: [{ id: "lint", mode: "inline", run: "exit 1", paths: ["src/**"] }],
        }),
      );

      const { code, stdout } = await runCli(["hook", "stop"], repo.root, { stdin });

      expect(code).toBe(0);
      const output = JSON.parse(stdout);
      expect(Object.keys(output)).toEqual(["systemMessage"]);
      expect(output.systemMessage).toContain("ゲートが働かなかった");
      expect(output.systemMessage).toContain(cause);
      expect(existsSync(resolveLocations(repo.root).worktreeDir)).toBe(false);
    },
  );

  it.each([
    ["空", "", '""'],
    [".", ".", '"."'],
    ["..", "..", '".."'],
    ["/ を含む", "../outside", '"../outside"'],
  ])(
    "session_id が %s なら、何も書かず、ゲートが働かなかったことと原因を systemMessage で知らせて通す",
    async (_, sessionId, cause) => {
      const repo = createRepo();
      onTestFinished(() => repo.cleanup());
      repo.write("src/a.ts", "a");
      repo.write(
        ".menou.json",
        JSON.stringify({
          checks: [{ id: "lint", mode: "inline", run: "exit 1", paths: ["src/**"] }],
        }),
      );

      const { code, stdout } = await runCli(["hook", "stop"], repo.root, {
        stdin: JSON.stringify({ session_id: sessionId, prompt_id: "prompt-1" }),
      });

      expect(code).toBe(0);
      const output = JSON.parse(stdout);
      expect(Object.keys(output)).toEqual(["systemMessage"]);
      expect(output.systemMessage).toContain("ゲートが働かなかった");
      expect(output.systemMessage).toContain(cause);
      expect(existsSync(resolveLocations(repo.root).worktreeDir)).toBe(false);
    },
  );

  it("判定の途中で思わぬ失敗が起きたら、ゲートが働かなかったことと原因を systemMessage で知らせて通す", async () => {
    const repo = createRepo();
    onTestFinished(() => repo.cleanup());
    repo.write("src/a.ts", "a");
    repo.write(
      ".menou.json",
      JSON.stringify({
        checks: [{ id: "lint", mode: "inline", run: "exit 1", paths: ["src/**"] }],
      }),
    );
    const { worktreeDir } = resolveLocations(repo.root);
    mkdirSync(worktreeDir, { recursive: true });
    writeFileSync(join(worktreeDir, "sessions"), "ブロック回数を書けないようにするファイル");

    const { code, stdout } = await runCli(["hook", "stop"], repo.root, {
      stdin: JSON.stringify({ session_id: "session-a", prompt_id: "prompt-1" }),
    });

    expect(code).toBe(0);
    const output = JSON.parse(stdout);
    expect(Object.keys(output)).toEqual(["systemMessage"]);
    expect(output.systemMessage).toContain("ゲートが働かなかった");
    expect(output.systemMessage).toContain("ENOTDIR");
  });
});
