import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type CheckRecord,
  type Locations,
  prepareOutDir,
  readRecord,
  resolveLocations,
  writeRecord,
} from "../src/store";
import { createRepo, type Repo } from "./repo";

const fingerprintA = "a".repeat(64);
const fingerprintB = "b".repeat(64);

function record(overrides: Partial<CheckRecord> = {}): CheckRecord {
  return {
    id: "lint",
    fingerprint: fingerprintA,
    result: "pass",
    finishedAt: "2026-11-06T00:00:00.000Z",
    ...overrides,
  } as CheckRecord;
}

let repo: Repo;
let locations: Locations;

beforeEach(() => {
  repo = createRepo();
  repo.write("a.txt", "a");
  repo.commitAll();
  locations = resolveLocations(repo.root);
});

afterEach(() => {
  repo.cleanup();
});

describe("記録の読み書き", () => {
  it("書いた記録を、同じ id とフィンガープリントで読み直せる", () => {
    writeRecord(locations, record());

    expect(readRecord(locations, "lint", fingerprintA)).toEqual(record());
  });

  it("フィンガープリントが違えば、記録はない", () => {
    writeRecord(locations, record());

    expect(readRecord(locations, "lint", fingerprintB)).toBeUndefined();
  });

  it("フィンガープリントが同じでも、id が違うチェックの記録は読まない", () => {
    writeRecord(locations, record({ id: "lint" }));

    expect(readRecord(locations, "format", fingerprintA)).toBeUndefined();
  });

  it("同じ id とフィンガープリントで書き直すと、あとの結果を読む", () => {
    writeRecord(locations, record({ result: "fail" }));
    writeRecord(locations, record({ result: "pass" }));

    expect(readRecord(locations, "lint", fingerprintA)?.result).toBe("pass");
  });

  it("書き終えたら、一時ファイルを残さない", () => {
    writeRecord(locations, record());

    const dir = join(locations.resultsDir, "lint");
    expect(readdirSync(dir)).toEqual([`${fingerprintA}.json`]);
  });

  it("記録のファイルが JSON として読めなければ、記録なしとして扱う", () => {
    writeRecord(locations, record());
    writeFileSync(join(locations.resultsDir, "lint", `${fingerprintA}.json`), "{");

    expect(readRecord(locations, "lint", fingerprintA)).toBeUndefined();
  });

  it("記録のファイルの中身が別のフィンガープリントのものなら、記録なしとして扱う", () => {
    writeRecord(locations, record());
    writeFileSync(
      join(locations.resultsDir, "lint", `${fingerprintA}.json`),
      JSON.stringify(record({ fingerprint: fingerprintB })),
    );

    expect(readRecord(locations, "lint", fingerprintA)).toBeUndefined();
  });

  it("エラーの記録は、エラーになった理由ごと読み直せる", () => {
    const error = record({ result: "error", cause: { kind: "timeout", seconds: 120 } });
    writeRecord(locations, error);

    expect(readRecord(locations, "lint", fingerprintA)).toEqual(error);
  });
});

describe("git worktree での置き場所", () => {
  let worktree: string;

  beforeEach(() => {
    worktree = `${repo.root}-wt`;
    repo.git("worktree", "add", "-q", worktree);
  });

  afterEach(() => {
    repo.git("worktree", "remove", "--force", worktree);
  });

  it("ある worktree で書いた記録を、別の worktree から読める", () => {
    writeRecord(resolveLocations(worktree), record());

    expect(readRecord(locations, "lint", fingerprintA)).toEqual(record());
  });

  it("MENOU_OUT のディレクトリは worktree ごとに分かれる", () => {
    expect(prepareOutDir(resolveLocations(worktree), "lint")).not.toBe(
      prepareOutDir(locations, "lint"),
    );
  });
});

describe("MENOU_OUT のディレクトリ", () => {
  it("まだなければ作る", () => {
    const dir = prepareOutDir(locations, "review");

    expect(readdirSync(dir)).toEqual([]);
  });

  it("前の実行で書き出したファイルを消して、空にする", () => {
    const dir = prepareOutDir(locations, "review");
    writeFileSync(join(dir, "findings.md"), "old");

    expect(prepareOutDir(locations, "review")).toBe(dir);
    expect(existsSync(join(dir, "findings.md"))).toBe(false);
  });

  it("チェックごとに分かれていて、ほかのチェックの書き出したファイルは消さない", () => {
    const lintDir = prepareOutDir(locations, "lint");
    writeFileSync(join(lintDir, "report.txt"), "lint");

    prepareOutDir(locations, "review");

    expect(existsSync(join(lintDir, "report.txt"))).toBe(true);
  });

  it("作業ツリーの外（git ディレクトリの中）にあり、フィンガープリントの対象にならない", () => {
    const dir = prepareOutDir(locations, "review");

    expect(dir.startsWith(join(repo.root, ".git"))).toBe(true);
  });
});
