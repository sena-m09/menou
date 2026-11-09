import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as v from "valibot";
import { describe, expect, it, onTestFinished } from "vitest";
import { runAndRecord } from "../src/check-runner";
import { loadConfig } from "../src/config";
import { judgeStop } from "../src/gate";
import { SessionIdSchema, recordBaseline } from "../src/session";
import { takeSnapshot } from "../src/snapshot";
import { resolveLocations } from "../src/store";
import { createRepo } from "./repo";

describe("通すとき", () => {
  it(".menou.json がなければ、何も書かずに通す", async () => {
    const repo = createRepo();
    onTestFinished(() => repo.cleanup());
    repo.write("src/a.ts", "a");
    const locations = resolveLocations(repo.root);
    const sessionId = v.parse(SessionIdSchema, "session-a");

    const result = await judgeStop({
      locations,
      config: loadConfig(repo.root),
      sessionId,
      promptId: "prompt-a",
    });

    expect(result).toMatchObject({ decision: "pass", checks: [] });
    expect(existsSync(locations.worktreeDir)).toBe(false);
  });

  it("作業ツリーがベースラインから変わっていなければ、不合格になるチェックがあっても実行せずに通す", async () => {
    const repo = createRepo();
    onTestFinished(() => repo.cleanup());
    repo.write("src/a.ts", "a");
    repo.write(
      ".menou.json",
      JSON.stringify({
        checks: [
          { id: "lint", mode: "inline", run: "echo ran >> ran.log; exit 1", paths: ["src/**"] },
        ],
      }),
    );
    const locations = resolveLocations(repo.root);
    const sessionId = v.parse(SessionIdSchema, "session-a");
    recordBaseline(locations, sessionId, () => takeSnapshot(repo.root, []).tree);

    const result = await judgeStop({
      locations,
      config: loadConfig(repo.root),
      sessionId,
      promptId: "prompt-a",
    });

    expect(result).toMatchObject({ decision: "pass", checks: [] });
    expect(existsSync(join(repo.root, "ran.log"))).toBe(false);
  });

  it("paths の範囲が変わっていないチェックは、対象外として求めない", async () => {
    const repo = createRepo();
    onTestFinished(() => repo.cleanup());
    repo.write("src/a.ts", "a");
    repo.write("README.md", "readme");
    repo.write(
      ".menou.json",
      JSON.stringify({
        checks: [
          { id: "lint", mode: "inline", run: "echo ran >> ran.log; exit 1", paths: ["src/**"] },
          { id: "e2e", mode: "evidence", run: "exit 1", paths: ["src/**"] },
        ],
      }),
    );
    const locations = resolveLocations(repo.root);
    const sessionId = v.parse(SessionIdSchema, "session-a");
    recordBaseline(locations, sessionId, () => takeSnapshot(repo.root, []).tree);
    repo.write("README.md", "changed");

    const result = await judgeStop({
      locations,
      config: loadConfig(repo.root),
      sessionId,
      promptId: "prompt-a",
    });

    expect(result).toMatchObject({
      decision: "pass",
      checks: [
        { check: { id: "lint" }, state: { kind: "out-of-scope" } },
        { check: { id: "e2e" }, state: { kind: "out-of-scope" } },
      ],
    });
    expect(existsSync(join(repo.root, "ran.log"))).toBe(false);
  });

  it("範囲が変わった inline 方式のチェックは、その場で実行して合格すれば通す", async () => {
    const repo = createRepo();
    onTestFinished(() => repo.cleanup());
    repo.write("src/a.ts", "a");
    repo.write(
      ".menou.json",
      JSON.stringify({
        checks: [{ id: "lint", mode: "inline", run: "exit 0", paths: ["src/**"] }],
      }),
    );
    const locations = resolveLocations(repo.root);
    const sessionId = v.parse(SessionIdSchema, "session-a");
    recordBaseline(locations, sessionId, () => takeSnapshot(repo.root, []).tree);
    repo.write("src/a.ts", "changed");

    const result = await judgeStop({
      locations,
      config: loadConfig(repo.root),
      sessionId,
      promptId: "prompt-a",
    });

    expect(result).toMatchObject({
      decision: "pass",
      checks: [{ check: { id: "lint" }, state: { kind: "ran", outcome: { result: "pass" } } }],
    });
  });

  it("今のフィンガープリントで合格した記録があれば、チェックを実行し直さずに通す", async () => {
    const repo = createRepo();
    onTestFinished(() => repo.cleanup());
    repo.write("src/a.ts", "a");
    repo.write(
      ".menou.json",
      JSON.stringify({
        checks: [{ id: "lint", mode: "inline", run: "echo ran >> ran.log", paths: ["src/**"] }],
      }),
    );
    const locations = resolveLocations(repo.root);
    const sessionId = v.parse(SessionIdSchema, "session-a");
    recordBaseline(locations, sessionId, () => takeSnapshot(repo.root, []).tree);
    repo.write("src/a.ts", "changed");
    const input = { locations, config: loadConfig(repo.root), sessionId, promptId: "prompt-a" };
    await judgeStop(input);

    const result = await judgeStop(input);

    expect(result).toMatchObject({
      decision: "pass",
      checks: [{ check: { id: "lint" }, state: { kind: "recorded-pass" } }],
    });
    expect(readFileSync(join(repo.root, "ran.log"), "utf8")).toBe("ran\n");
  });

  it("evidence 方式のチェックは、今のフィンガープリントで合格した記録があれば通す", async () => {
    const repo = createRepo();
    onTestFinished(() => repo.cleanup());
    repo.write("src/a.ts", "a");
    repo.write(
      ".menou.json",
      JSON.stringify({
        checks: [{ id: "e2e", mode: "evidence", run: "exit 0", paths: ["src/**"] }],
      }),
    );
    const locations = resolveLocations(repo.root);
    const sessionId = v.parse(SessionIdSchema, "session-a");
    recordBaseline(locations, sessionId, () => takeSnapshot(repo.root, []).tree);
    repo.write("src/a.ts", "changed");
    const config = loadConfig(repo.root);
    if (config.status !== "loaded") throw new Error(JSON.stringify(config));
    await runAndRecord(locations, config.config.checks[0] ?? expect.unreachable(), {
      stdio: "ignore",
    });

    const result = await judgeStop({ locations, config, sessionId, promptId: "prompt-a" });

    expect(result).toMatchObject({
      decision: "pass",
      checks: [{ check: { id: "e2e" }, state: { kind: "recorded-pass" } }],
    });
  });
});

describe("ブロックするとき", () => {
  it("inline 方式のチェックが不合格なら、menou run で出力を確かめるよう伝えてブロックする", async () => {
    const repo = createRepo();
    onTestFinished(() => repo.cleanup());
    repo.write("src/a.ts", "a");
    repo.write(
      ".menou.json",
      JSON.stringify({
        checks: [
          {
            id: "lint",
            mode: "inline",
            run: "exit 1",
            paths: ["src/**"],
            hint: "pnpm lint --fix で直せます",
          },
        ],
      }),
    );
    const locations = resolveLocations(repo.root);
    const sessionId = v.parse(SessionIdSchema, "session-a");
    recordBaseline(locations, sessionId, () => takeSnapshot(repo.root, []).tree);
    repo.write("src/a.ts", "changed");

    const result = await judgeStop({
      locations,
      config: loadConfig(repo.root),
      sessionId,
      promptId: "prompt-a",
    });

    expect(result).toMatchObject({
      decision: "block",
      checks: [{ check: { id: "lint" }, state: { kind: "ran", outcome: { result: "fail" } } }],
    });
    expect(result).toHaveProperty("reason", expect.stringContaining("menou run lint"));
    expect(result).toHaveProperty("reason", expect.stringContaining("pnpm lint --fix で直せます"));
  });

  it("inline 方式のチェックがエラーなら、コードの不合格ではなくチェック自体のエラーだと伝えてブロックする", async () => {
    const repo = createRepo();
    onTestFinished(() => repo.cleanup());
    repo.write("src/a.ts", "a");
    repo.write(
      ".menou.json",
      JSON.stringify({
        checks: [{ id: "lint", mode: "inline", run: "exit 3", paths: ["src/**"] }],
      }),
    );
    const locations = resolveLocations(repo.root);
    const sessionId = v.parse(SessionIdSchema, "session-a");
    recordBaseline(locations, sessionId, () => takeSnapshot(repo.root, []).tree);
    repo.write("src/a.ts", "changed");

    const result = await judgeStop({
      locations,
      config: loadConfig(repo.root),
      sessionId,
      promptId: "prompt-a",
    });

    expect(result).toMatchObject({
      decision: "block",
      checks: [
        {
          check: { id: "lint" },
          state: { kind: "ran", outcome: { result: "error", cause: { kind: "exit", code: 3 } } },
        },
      ],
    });
    expect(result).toHaveProperty("reason", expect.stringContaining("チェック自体のエラー"));
    expect(result).toHaveProperty("reason", expect.stringContaining("menou run lint"));
  });

  it("evidence 方式のチェックは、記録がなければ実行せず、menou run を実行するよう伝えてブロックする", async () => {
    const repo = createRepo();
    onTestFinished(() => repo.cleanup());
    repo.write("src/a.ts", "a");
    repo.write(
      ".menou.json",
      JSON.stringify({
        checks: [{ id: "e2e", mode: "evidence", run: "echo ran >> ran.log", paths: ["src/**"] }],
      }),
    );
    const locations = resolveLocations(repo.root);
    const sessionId = v.parse(SessionIdSchema, "session-a");
    recordBaseline(locations, sessionId, () => takeSnapshot(repo.root, []).tree);
    repo.write("src/a.ts", "changed");

    const result = await judgeStop({
      locations,
      config: loadConfig(repo.root),
      sessionId,
      promptId: "prompt-a",
    });

    expect(result).toMatchObject({
      decision: "block",
      checks: [{ check: { id: "e2e" }, state: { kind: "no-evidence" } }],
    });
    expect(result).toHaveProperty("reason", expect.stringContaining("menou run e2e"));
    expect(existsSync(join(repo.root, "ran.log"))).toBe(false);
  });

  it("block の前提のチェックが不合格なら、後ろのチェックは実行せず、前提を先に通すよう伝えてブロックする", async () => {
    const repo = createRepo();
    onTestFinished(() => repo.cleanup());
    repo.write("src/a.ts", "a");
    repo.write(
      ".menou.json",
      JSON.stringify({
        checks: [
          {
            id: "test",
            mode: "inline",
            run: "echo ran >> ran.log",
            paths: ["src/**"],
            needs: ["lint"],
          },
          { id: "lint", mode: "inline", run: "exit 1", paths: ["src/**"] },
        ],
      }),
    );
    const locations = resolveLocations(repo.root);
    const sessionId = v.parse(SessionIdSchema, "session-a");
    recordBaseline(locations, sessionId, () => takeSnapshot(repo.root, []).tree);
    repo.write("src/a.ts", "changed");

    const result = await judgeStop({
      locations,
      config: loadConfig(repo.root),
      sessionId,
      promptId: "prompt-a",
    });

    expect(result).toMatchObject({
      decision: "block",
      checks: [
        { check: { id: "lint" }, state: { kind: "ran", outcome: { result: "fail" } } },
        { check: { id: "test" }, state: { kind: "waiting", needs: ["lint"] } },
      ],
    });
    expect(existsSync(join(repo.root, "ran.log"))).toBe(false);
  });

  it("前提のチェックが対象外なら、通ったとみなして後ろのチェックを実行する", async () => {
    const repo = createRepo();
    onTestFinished(() => repo.cleanup());
    repo.write("src/a.ts", "a");
    repo.write("docs/a.md", "a");
    repo.write(
      ".menou.json",
      JSON.stringify({
        checks: [
          { id: "lint", mode: "inline", run: "exit 1", paths: ["docs/**"] },
          { id: "test", mode: "inline", run: "exit 0", paths: ["src/**"], needs: ["lint"] },
        ],
      }),
    );
    const locations = resolveLocations(repo.root);
    const sessionId = v.parse(SessionIdSchema, "session-a");
    recordBaseline(locations, sessionId, () => takeSnapshot(repo.root, []).tree);
    repo.write("src/a.ts", "changed");

    const result = await judgeStop({
      locations,
      config: loadConfig(repo.root),
      sessionId,
      promptId: "prompt-a",
    });

    expect(result).toMatchObject({
      decision: "pass",
      checks: [
        { check: { id: "lint" }, state: { kind: "out-of-scope" } },
        { check: { id: "test" }, state: { kind: "ran", outcome: { result: "pass" } } },
      ],
    });
  });

  it("warn の前提のチェックが不合格でも、後ろの block のチェックを実行し、合格なら警告を知らせて通す", async () => {
    const repo = createRepo();
    onTestFinished(() => repo.cleanup());
    repo.write("src/a.ts", "a");
    repo.write(
      ".menou.json",
      JSON.stringify({
        checks: [
          { id: "lint", mode: "inline", run: "exit 1", paths: ["src/**"], severity: "warn" },
          {
            id: "test",
            mode: "inline",
            run: "echo ran >> ran.log",
            paths: ["src/**"],
            needs: ["lint"],
          },
        ],
      }),
    );
    const locations = resolveLocations(repo.root);
    const sessionId = v.parse(SessionIdSchema, "session-a");
    recordBaseline(locations, sessionId, () => takeSnapshot(repo.root, []).tree);
    repo.write("src/a.ts", "changed");

    const result = await judgeStop({
      locations,
      config: loadConfig(repo.root),
      sessionId,
      promptId: "prompt-a",
    });

    expect(result).toMatchObject({
      decision: "pass",
      checks: [
        { check: { id: "lint" }, state: { kind: "ran", outcome: { result: "fail" } } },
        { check: { id: "test" }, state: { kind: "ran", outcome: { result: "pass" } } },
      ],
    });
    expect(result).toHaveProperty("notice", expect.stringContaining("menou run lint"));
    expect(readFileSync(join(repo.root, "ran.log"), "utf8")).toBe("ran\n");
  });

  it("warn の前提のチェックが不合格で、後ろの block のチェックも不合格なら、ブロックする", async () => {
    const repo = createRepo();
    onTestFinished(() => repo.cleanup());
    repo.write("src/a.ts", "a");
    repo.write(
      ".menou.json",
      JSON.stringify({
        checks: [
          { id: "lint", mode: "inline", run: "exit 1", paths: ["src/**"], severity: "warn" },
          { id: "test", mode: "inline", run: "exit 1", paths: ["src/**"], needs: ["lint"] },
        ],
      }),
    );
    const locations = resolveLocations(repo.root);
    const sessionId = v.parse(SessionIdSchema, "session-a");
    recordBaseline(locations, sessionId, () => takeSnapshot(repo.root, []).tree);
    repo.write("src/a.ts", "changed");

    const result = await judgeStop({
      locations,
      config: loadConfig(repo.root),
      sessionId,
      promptId: "prompt-a",
    });

    expect(result).toMatchObject({
      decision: "block",
      checks: [
        { check: { id: "lint" }, state: { kind: "ran", outcome: { result: "fail" } } },
        { check: { id: "test" }, state: { kind: "ran", outcome: { result: "fail" } } },
      ],
    });
    expect(result).toHaveProperty("reason", expect.stringContaining("menou run test"));
    expect(result).toHaveProperty("notice", expect.stringContaining("menou run lint"));
  });

  it(".menou.json がベースラインから変わっていたら、paths の範囲が変わっていないチェックも求める", async () => {
    const repo = createRepo();
    onTestFinished(() => repo.cleanup());
    repo.write("src/a.ts", "a");
    repo.write(
      ".menou.json",
      JSON.stringify({
        checks: [{ id: "lint", mode: "inline", run: "exit 1", paths: ["src/**"] }],
      }),
    );
    const locations = resolveLocations(repo.root);
    const sessionId = v.parse(SessionIdSchema, "session-a");
    recordBaseline(locations, sessionId, () => takeSnapshot(repo.root, []).tree);
    repo.write(
      ".menou.json",
      JSON.stringify({
        checks: [{ id: "lint", mode: "inline", run: "exit 1", paths: ["src/**"], hint: "x" }],
      }),
    );

    const result = await judgeStop({
      locations,
      config: loadConfig(repo.root),
      sessionId,
      promptId: "prompt-a",
    });

    expect(result).toMatchObject({
      decision: "block",
      checks: [{ check: { id: "lint" }, state: { kind: "ran", outcome: { result: "fail" } } }],
    });
  });

  it("このセッションのベースラインがなければ、作業ツリーが変わっていなくても、すべてのチェックを求める", async () => {
    const repo = createRepo();
    onTestFinished(() => repo.cleanup());
    repo.write("src/a.ts", "a");
    repo.write(
      ".menou.json",
      JSON.stringify({
        checks: [{ id: "lint", mode: "inline", run: "exit 1", paths: ["src/**"] }],
      }),
    );
    const locations = resolveLocations(repo.root);
    recordBaseline(
      locations,
      v.parse(SessionIdSchema, "other-session"),
      () => takeSnapshot(repo.root, []).tree,
    );

    const result = await judgeStop({
      locations,
      config: loadConfig(repo.root),
      sessionId: v.parse(SessionIdSchema, "session-a"),
      promptId: "prompt-a",
    });

    expect(result).toMatchObject({
      decision: "block",
      checks: [{ check: { id: "lint" }, state: { kind: "ran", outcome: { result: "fail" } } }],
    });
  });

  it("ベースラインの tree が消えていて比べられなければ、すべてのチェックを求める", async () => {
    const repo = createRepo();
    onTestFinished(() => repo.cleanup());
    repo.write("src/a.ts", "a");
    repo.write("README.md", "readme");
    repo.write(
      ".menou.json",
      JSON.stringify({
        checks: [{ id: "lint", mode: "inline", run: "exit 1", paths: ["src/**"] }],
      }),
    );
    const locations = resolveLocations(repo.root);
    mkdirSync(join(locations.worktreeDir, "sessions", "session-a"), { recursive: true });
    writeFileSync(
      join(locations.worktreeDir, "sessions", "session-a", "baseline.json"),
      JSON.stringify({ tree: "0".repeat(40), recordedAt: "2026-11-09T00:00:00.000Z" }),
    );
    repo.write("README.md", "changed");

    const result = await judgeStop({
      locations,
      config: loadConfig(repo.root),
      sessionId: v.parse(SessionIdSchema, "session-a"),
      promptId: "prompt-a",
    });

    expect(result).toMatchObject({
      decision: "block",
      checks: [{ check: { id: "lint" }, state: { kind: "ran", outcome: { result: "fail" } } }],
    });
  });

  it(".menou.json が不正なら、利用者に直してもらうよう伝えてブロックする", async () => {
    const repo = createRepo();
    onTestFinished(() => repo.cleanup());
    repo.write(".menou.json", JSON.stringify({ checks: [{ id: "lint" }] }));
    const locations = resolveLocations(repo.root);

    const result = await judgeStop({
      locations,
      config: loadConfig(repo.root),
      sessionId: v.parse(SessionIdSchema, "session-a"),
      promptId: "prompt-a",
    });

    expect(result).toMatchObject({ decision: "block", checks: [] });
    expect(result).toHaveProperty("reason", expect.stringContaining(".menou.json"));
    expect(result).toHaveProperty("reason", expect.stringContaining("checks[0]"));
  });
});

describe("チェックに渡すもの", () => {
  it("inline 方式のチェックには MENOU_DISABLED=1 を渡す", async () => {
    const repo = createRepo();
    onTestFinished(() => repo.cleanup());
    repo.write("src/a.ts", "a");
    repo.write(
      ".menou.json",
      JSON.stringify({
        checks: [
          { id: "lint", mode: "inline", run: 'test "$MENOU_DISABLED" = 1', paths: ["src/**"] },
        ],
      }),
    );
    const locations = resolveLocations(repo.root);
    const sessionId = v.parse(SessionIdSchema, "session-a");
    recordBaseline(locations, sessionId, () => takeSnapshot(repo.root, []).tree);
    repo.write("src/a.ts", "changed");

    const result = await judgeStop({
      locations,
      config: loadConfig(repo.root),
      sessionId,
      promptId: "prompt-a",
    });

    expect(result).toMatchObject({
      decision: "pass",
      checks: [{ state: { kind: "ran", outcome: { result: "pass" } } }],
    });
  });

  it("inline 方式のチェックには、このセッションのベースラインを MENOU_BASELINE として渡す", async () => {
    const repo = createRepo();
    onTestFinished(() => repo.cleanup());
    repo.write("src/a.ts", "a");
    repo.write(
      ".menou.json",
      JSON.stringify({
        checks: [
          {
            id: "lint",
            mode: "inline",
            run: 'printenv MENOU_BASELINE > "$MENOU_OUT/baseline.txt"',
            paths: ["src/**"],
          },
        ],
      }),
    );
    const locations = resolveLocations(repo.root);
    const sessionId = v.parse(SessionIdSchema, "session-a");
    const baseline = takeSnapshot(repo.root, []).tree;
    recordBaseline(locations, sessionId, () => baseline);
    repo.write("src/a.ts", "changed");

    await judgeStop({ locations, config: loadConfig(repo.root), sessionId, promptId: "prompt-a" });

    expect(readFileSync(join(locations.worktreeDir, "out", "lint", "baseline.txt"), "utf8")).toBe(
      `${baseline}\n`,
    );
  });
});

describe("1 回の Stop で使える時間", () => {
  it("timeout を足すと使える時間を超える inline 方式のチェックは、実行せずに不足として menou run を実行するよう伝える", async () => {
    const repo = createRepo();
    onTestFinished(() => repo.cleanup());
    repo.write("src/a.ts", "a");
    repo.write(
      ".menou.json",
      JSON.stringify({
        checks: [
          {
            id: "lint",
            mode: "inline",
            run: "echo ran >> ran.log",
            paths: ["src/**"],
            timeout: 120,
          },
        ],
      }),
    );
    const locations = resolveLocations(repo.root);
    const sessionId = v.parse(SessionIdSchema, "session-a");
    recordBaseline(locations, sessionId, () => takeSnapshot(repo.root, []).tree);
    repo.write("src/a.ts", "changed");

    const result = await judgeStop(
      { locations, config: loadConfig(repo.root), sessionId, promptId: "prompt-a" },
      { budgetSeconds: 60 },
    );

    expect(result).toMatchObject({
      decision: "block",
      checks: [{ check: { id: "lint" }, state: { kind: "over-budget", budgetSeconds: 60 } }],
    });
    expect(result).toHaveProperty("reason", expect.stringContaining("menou run lint"));
    expect(existsSync(join(repo.root, "ran.log"))).toBe(false);
  });

  it("前のチェックにかかった時間も使える時間から引く", async () => {
    const repo = createRepo();
    onTestFinished(() => repo.cleanup());
    repo.write("src/a.ts", "a");
    repo.write(
      ".menou.json",
      JSON.stringify({
        checks: [
          { id: "slow", mode: "inline", run: "sleep 1", paths: ["src/**"], timeout: 2 },
          { id: "next", mode: "inline", run: "exit 0", paths: ["src/**"], timeout: 2 },
        ],
      }),
    );
    const locations = resolveLocations(repo.root);
    const sessionId = v.parse(SessionIdSchema, "session-a");
    recordBaseline(locations, sessionId, () => takeSnapshot(repo.root, []).tree);
    repo.write("src/a.ts", "changed");

    const result = await judgeStop(
      { locations, config: loadConfig(repo.root), sessionId, promptId: "prompt-a" },
      { budgetSeconds: 2.5 },
    );

    expect(result).toMatchObject({
      checks: [
        { check: { id: "slow" }, state: { kind: "ran", outcome: { result: "pass" } } },
        { check: { id: "next" }, state: { kind: "over-budget" } },
      ],
    });
  });
});

describe("warn のチェック", () => {
  it("不足があってもブロックせず、人に知らせる文を付けて通す", async () => {
    const repo = createRepo();
    onTestFinished(() => repo.cleanup());
    repo.write("src/a.ts", "a");
    repo.write(
      ".menou.json",
      JSON.stringify({
        checks: [
          { id: "lint", mode: "inline", run: "exit 1", paths: ["src/**"], severity: "warn" },
        ],
      }),
    );
    const locations = resolveLocations(repo.root);
    const sessionId = v.parse(SessionIdSchema, "session-a");
    recordBaseline(locations, sessionId, () => takeSnapshot(repo.root, []).tree);
    repo.write("src/a.ts", "changed");

    const result = await judgeStop({
      locations,
      config: loadConfig(repo.root),
      sessionId,
      promptId: "prompt-a",
    });

    expect(result).toMatchObject({ decision: "pass" });
    expect(result).toHaveProperty("notice", expect.stringContaining("menou run lint"));
  });
});

describe("ブロック回数", () => {
  it("同じプロンプトで maxBlocks 回ブロックしたら、次は不足があっても通して人に知らせる", async () => {
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
    const locations = resolveLocations(repo.root);
    const sessionId = v.parse(SessionIdSchema, "session-a");
    recordBaseline(locations, sessionId, () => takeSnapshot(repo.root, []).tree);
    repo.write("src/a.ts", "changed");
    const input = { locations, config: loadConfig(repo.root), sessionId, promptId: "prompt-a" };

    const results = [await judgeStop(input), await judgeStop(input), await judgeStop(input)];

    expect(results.map((result) => result.decision)).toEqual(["block", "block", "limit"]);
    expect(results[2]).toHaveProperty("notice", expect.stringContaining("menou run lint"));
  });

  it("プロンプトの ID が前にブロックしたときと違えば、数え直してブロックする", async () => {
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
    const locations = resolveLocations(repo.root);
    const sessionId = v.parse(SessionIdSchema, "session-a");
    recordBaseline(locations, sessionId, () => takeSnapshot(repo.root, []).tree);
    repo.write("src/a.ts", "changed");
    const config = loadConfig(repo.root);

    const decisions = [
      (await judgeStop({ locations, config, sessionId, promptId: "prompt-a" })).decision,
      (await judgeStop({ locations, config, sessionId, promptId: "prompt-a" })).decision,
      (await judgeStop({ locations, config, sessionId, promptId: "prompt-b" })).decision,
    ];

    expect(decisions).toEqual(["block", "limit", "block"]);
  });

  it("すべてのチェックを満たして通したら、同じプロンプトでも数え直す", async () => {
    const repo = createRepo();
    onTestFinished(() => repo.cleanup());
    repo.write("src/a.ts", "ok");
    repo.write(
      ".menou.json",
      JSON.stringify({
        maxBlocks: 1,
        checks: [{ id: "lint", mode: "inline", run: "grep -qx ok src/a.ts", paths: ["src/**"] }],
      }),
    );
    const locations = resolveLocations(repo.root);
    const sessionId = v.parse(SessionIdSchema, "session-a");
    recordBaseline(locations, sessionId, () => takeSnapshot(repo.root, []).tree);
    const input = { locations, config: loadConfig(repo.root), sessionId, promptId: "prompt-a" };

    repo.write("src/a.ts", "broken");
    const first = (await judgeStop(input)).decision;
    repo.write("src/a.ts", "ok\n");
    const second = (await judgeStop(input)).decision;
    repo.write("src/a.ts", "broken again");
    const third = (await judgeStop(input)).decision;

    expect([first, second, third]).toEqual(["block", "pass", "block"]);
  });

  it(".menou.json が不正なら、書かれた maxBlocks ではなく既定の 3 回でブロックをやめて人に知らせる", async () => {
    const repo = createRepo();
    onTestFinished(() => repo.cleanup());
    repo.write(".menou.json", JSON.stringify({ maxBlocks: 10, checks: "lint" }));
    const locations = resolveLocations(repo.root);
    const input = {
      locations,
      config: loadConfig(repo.root),
      sessionId: v.parse(SessionIdSchema, "session-a"),
      promptId: "prompt-a",
    };

    const decisions = [
      (await judgeStop(input)).decision,
      (await judgeStop(input)).decision,
      (await judgeStop(input)).decision,
    ];
    const last = await judgeStop(input);

    expect(decisions).toEqual(["block", "block", "block"]);
    expect(last).toMatchObject({ decision: "limit" });
    expect(last).toHaveProperty("notice", expect.stringContaining(".menou.json"));
  });
});

describe("evidence 方式の不合格の記録", () => {
  it("この worktree で取った記録なら、MENOU_OUT の詳細の場所を伝える", async () => {
    const repo = createRepo();
    onTestFinished(() => repo.cleanup());
    repo.write("src/a.ts", "a");
    repo.write(
      ".menou.json",
      JSON.stringify({
        checks: [{ id: "review", mode: "evidence", run: "exit 1", paths: ["src/**"] }],
      }),
    );
    const locations = resolveLocations(repo.root);
    const sessionId = v.parse(SessionIdSchema, "session-a");
    recordBaseline(locations, sessionId, () => takeSnapshot(repo.root, []).tree);
    repo.write("src/a.ts", "changed");
    const config = loadConfig(repo.root);
    if (config.status !== "loaded") throw new Error(JSON.stringify(config));
    await runAndRecord(locations, config.config.checks[0] ?? expect.unreachable(), {
      stdio: "ignore",
    });

    const result = await judgeStop({ locations, config, sessionId, promptId: "prompt-a" });

    expect(result).toMatchObject({
      decision: "block",
      checks: [{ check: { id: "review" }, state: { kind: "failed-evidence", here: true } }],
    });
    expect(result).toHaveProperty(
      "reason",
      expect.stringContaining(join(locations.worktreeDir, "out", "review")),
    );
  });

  it("別の worktree で取った記録なら、詳細の場所ではなく menou run で取り直すよう伝える", async () => {
    const repo = createRepo();
    onTestFinished(() => repo.cleanup());
    repo.write("src/a.ts", "a");
    repo.write(
      ".menou.json",
      JSON.stringify({
        checks: [{ id: "review", mode: "evidence", run: "exit 1", paths: ["src/**"] }],
      }),
    );
    repo.commitAll();
    const locations = resolveLocations(repo.root);
    const sessionId = v.parse(SessionIdSchema, "session-a");
    recordBaseline(locations, sessionId, () => takeSnapshot(repo.root, []).tree);
    repo.write("src/a.ts", "changed");
    const worktree = `${repo.root}-wt`;
    repo.git("worktree", "add", "-q", worktree);
    onTestFinished(() => {
      repo.git("worktree", "remove", "--force", worktree);
    });
    writeFileSync(join(worktree, "src/a.ts"), "changed");
    const config = loadConfig(repo.root);
    if (config.status !== "loaded") throw new Error(JSON.stringify(config));
    await runAndRecord(
      resolveLocations(worktree),
      config.config.checks[0] ?? expect.unreachable(),
      {
        stdio: "ignore",
      },
    );

    const result = await judgeStop({ locations, config, sessionId, promptId: "prompt-a" });

    expect(result).toMatchObject({
      decision: "block",
      checks: [{ check: { id: "review" }, state: { kind: "failed-evidence", here: false } }],
    });
    expect(result).toHaveProperty("reason", expect.stringContaining("menou run review"));
    expect(result).toHaveProperty("reason", expect.stringContaining("取り直"));
    expect(result).not.toHaveProperty("reason", expect.stringContaining(join("out", "review")));
  });
});
