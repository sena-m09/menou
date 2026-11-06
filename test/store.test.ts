import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect } from "vitest";
import {
  type CheckRecord,
  type Locations,
  type Outcome,
  prepareOutDir,
  readRecord,
  resolveLocations,
  writeRecord,
} from "../src/store";
import { temporaryName } from "../src/temp-file";
import { testWithRepo } from "./repo";

const fingerprintA = "a".repeat(64);
const fingerprintB = "b".repeat(64);

interface RecordOverrides {
  id?: string;
  fingerprint?: string;
  outcome?: Outcome;
}

function record({ outcome = { result: "pass" }, ...fields }: RecordOverrides = {}): CheckRecord {
  return {
    id: "lint",
    fingerprint: fingerprintA,
    finishedAt: "2026-11-06T00:00:00.000Z",
    ...fields,
    ...outcome,
  };
}

const it = testWithRepo((repo) => {
  repo.write("a.txt", "a");
  repo.commitAll();
}).extend("locations", ({ repo }) => resolveLocations(repo.root));

describe("記録の読み書き", () => {
  it("書いた記録を、同じ id とフィンガープリントで読み直せる", ({ locations }) => {
    writeRecord(locations, record());

    expect(readRecord(locations, "lint", fingerprintA)).toEqual(record());
  });

  it("フィンガープリントが違えば、記録はない", ({ locations }) => {
    writeRecord(locations, record());

    expect(readRecord(locations, "lint", fingerprintB)).toBeUndefined();
  });

  it("フィンガープリントが同じでも、id が違うチェックの記録は読まない", ({ locations }) => {
    writeRecord(locations, record({ id: "lint" }));

    expect(readRecord(locations, "format", fingerprintA)).toBeUndefined();
  });

  it("run と paths が同じでフィンガープリントが重なる 2 つのチェックも、それぞれの記録を読める", ({
    locations,
  }) => {
    writeRecord(locations, record({ id: "lint", outcome: { result: "pass" } }));
    writeRecord(locations, record({ id: "format", outcome: { result: "fail" } }));

    expect(readRecord(locations, "lint", fingerprintA)?.result).toBe("pass");
    expect(readRecord(locations, "format", fingerprintA)?.result).toBe("fail");
  });

  it("同じ id とフィンガープリントで書き直すと、あとの結果を読む", ({ locations }) => {
    writeRecord(locations, record({ outcome: { result: "fail" } }));
    writeRecord(locations, record({ outcome: { result: "pass" } }));

    expect(readRecord(locations, "lint", fingerprintA)?.result).toBe("pass");
  });

  it("書き終えたら、一時ファイルを残さない", ({ locations }) => {
    writeRecord(locations, record());

    expect(readdirSync(join(locations.resultsDir, "lint"))).toEqual([`${fingerprintA}.json`]);
    expect(readdirSync(locations.tempDir)).toEqual([]);
  });

  describe("強制終了で残った記録の一時ファイル", () => {
    const hour = 60 * 60 * 1000;

    function leave(locations: Locations, name: string) {
      mkdirSync(locations.tempDir, { recursive: true });
      writeFileSync(join(locations.tempDir, name), "{");
      return join(locations.tempDir, name);
    }

    it("作ってから 1 時間を過ぎたものは、次に記録を書くときに消す", ({ locations }) => {
      const stale = leave(locations, temporaryName("record", Date.now() - hour - 60_000));

      writeRecord(locations, record());

      expect(existsSync(stale)).toBe(false);
    });

    it("作ってから 1 時間以内のものは、ほかの menou が書いている途中かもしれないので消さない", ({
      locations,
    }) => {
      const recent = leave(locations, temporaryName("record", Date.now() - hour + 60_000));

      writeRecord(locations, record());

      expect(existsSync(recent)).toBe(true);
    });
  });

  it("記録のファイルが JSON として読めなければ、記録なしとして扱う", ({ locations }) => {
    writeRecord(locations, record());
    writeFileSync(join(locations.resultsDir, "lint", `${fingerprintA}.json`), "{");

    expect(readRecord(locations, "lint", fingerprintA)).toBeUndefined();
  });

  it("記録のファイルの中身が別のフィンガープリントのものなら、記録なしとして扱う", ({
    locations,
  }) => {
    writeRecord(locations, record());
    writeFileSync(
      join(locations.resultsDir, "lint", `${fingerprintA}.json`),
      JSON.stringify(record({ fingerprint: fingerprintB })),
    );

    expect(readRecord(locations, "lint", fingerprintA)).toBeUndefined();
  });

  it("記録のファイルの中身が別の id のものなら、記録なしとして扱う", ({ locations }) => {
    writeRecord(locations, record());
    writeFileSync(
      join(locations.resultsDir, "lint", `${fingerprintA}.json`),
      JSON.stringify(record({ id: "format" })),
    );

    expect(readRecord(locations, "lint", fingerprintA)).toBeUndefined();
  });

  it.for([
    ["終わった時刻がない", { id: "lint", fingerprint: fingerprintA, result: "pass" }],
    [
      "結果がない",
      { id: "lint", fingerprint: fingerprintA, finishedAt: "2026-11-06T00:00:00.000Z" },
    ],
    [
      "エラーなのに理由がない",
      {
        id: "lint",
        fingerprint: fingerprintA,
        result: "error",
        finishedAt: "2026-11-06T00:00:00.000Z",
      },
    ],
  ])("記録のファイルの中身に%sなら、記録なしとして扱う", ([, content], { locations }) => {
    writeRecord(locations, record());
    writeFileSync(
      join(locations.resultsDir, "lint", `${fingerprintA}.json`),
      JSON.stringify(content),
    );

    expect(readRecord(locations, "lint", fingerprintA)).toBeUndefined();
  });

  it("エラーの記録は、エラーになった理由ごと読み直せる", ({ locations }) => {
    const error = record({
      outcome: { result: "error", cause: { kind: "timeout", seconds: 120 } },
    });
    writeRecord(locations, error);

    expect(readRecord(locations, "lint", fingerprintA)).toEqual(error);
  });
});

describe("git worktree での置き場所", () => {
  const worktreeTest = it.extend("worktree", ({ repo }, { onCleanup }) => {
    const worktree = `${repo.root}-wt`;
    repo.git("worktree", "add", "-q", worktree);
    onCleanup(() => {
      repo.git("worktree", "remove", "--force", worktree);
    });
    return worktree;
  });

  worktreeTest(
    "ある worktree で書いた記録を、別の worktree から読める",
    ({ locations, worktree }) => {
      writeRecord(resolveLocations(worktree), record());

      expect(readRecord(locations, "lint", fingerprintA)).toEqual(record());
    },
  );

  worktreeTest("MENOU_OUT のディレクトリは worktree ごとに分かれる", ({ locations, worktree }) => {
    expect(prepareOutDir(resolveLocations(worktree), "lint")).not.toBe(
      prepareOutDir(locations, "lint"),
    );
  });
});

describe("MENOU_OUT のディレクトリ", () => {
  it("まだなければ作る", ({ locations }) => {
    const dir = prepareOutDir(locations, "review");

    expect(readdirSync(dir)).toEqual([]);
  });

  it("前の実行で書き出したファイルを消して、空にする", ({ locations }) => {
    const dir = prepareOutDir(locations, "review");
    writeFileSync(join(dir, "findings.md"), "old");

    expect(prepareOutDir(locations, "review")).toBe(dir);
    expect(existsSync(join(dir, "findings.md"))).toBe(false);
  });

  it("チェックごとに分かれていて、ほかのチェックの書き出したファイルは消さない", ({
    locations,
  }) => {
    const lintDir = prepareOutDir(locations, "lint");
    writeFileSync(join(lintDir, "report.txt"), "lint");

    prepareOutDir(locations, "review");

    expect(existsSync(join(lintDir, "report.txt"))).toBe(true);
  });

  it("作業ツリーの外（git ディレクトリの中）にあり、フィンガープリントの対象にならない", ({
    repo,
    locations,
  }) => {
    const dir = prepareOutDir(locations, "review");

    expect(dir.startsWith(join(repo.root, ".git"))).toBe(true);
  });
});
