import { readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { takeSnapshot } from "../src/snapshot";
import { createRepo, type Repo } from "./repo";

let repo: Repo;

beforeEach(() => {
  repo = createRepo();
  repo.write("src/a.ts", "a");
  repo.write("README.md", "readme");
  repo.commitAll();
});

afterEach(() => {
  vi.unstubAllEnvs();
  repo.cleanup();
});

function treeOfCommittingEverything() {
  repo.commitAll();
  return repo.git("rev-parse", "HEAD^{tree}").trim();
}

describe("作業ツリー全体の tree", () => {
  it("コミットしていない変更と追跡していないファイルを、すべてコミットしたときと同じ tree になる", () => {
    repo.write("src/a.ts", "changed");
    repo.write("src/new.ts", "new");
    repo.remove("README.md");

    const { tree } = takeSnapshot(repo.root, []);

    expect(tree).toBe(treeOfCommittingEverything());
  });

  it(".gitignore の対象は tree に入らず、対象から外せば入る", () => {
    repo.write(".gitignore", "*.log\n");
    repo.write("debug.log", "log");
    const ignored = takeSnapshot(repo.root, []).tree;

    expect(repo.git("ls-tree", "-r", "--name-only", ignored)).not.toContain("debug.log");

    repo.write(".gitignore", "");

    expect(repo.git("ls-tree", "-r", "--name-only", takeSnapshot(repo.root, []).tree)).toContain(
      "debug.log",
    );
  });

  it("git add した内容でなく、作業ツリーの今の内容で取る", () => {
    repo.write("src/a.ts", "staged");
    repo.git("add", "src/a.ts");
    repo.write("src/a.ts", "working");

    const { tree } = takeSnapshot(repo.root, []);

    expect(tree).toBe(treeOfCommittingEverything());
  });

  it("中身を変えて元に戻すと、元の tree に戻る", () => {
    const before = takeSnapshot(repo.root, []).tree;
    repo.write("src/a.ts", "changed");

    expect(takeSnapshot(repo.root, []).tree).not.toBe(before);

    repo.write("src/a.ts", "a");

    expect(takeSnapshot(repo.root, []).tree).toBe(before);
  });
});

describe("実際のインデックス", () => {
  it("git add した状態は、取ったあとも変わらない", () => {
    repo.write("src/a.ts", "staged");
    repo.git("add", "src/a.ts");
    repo.write("src/a.ts", "working");
    repo.write("src/new.ts", "untracked");
    const before = repo.indexBytes();

    takeSnapshot(repo.root, [["src/**"]]);

    expect(repo.indexBytes()).toEqual(before);
  });

  it("マージの衝突を解決していない途中でも取れて、衝突の状態はそのまま残る", () => {
    repo.git("switch", "-q", "-c", "other");
    repo.write("src/a.ts", "other");
    repo.commitAll();
    repo.git("switch", "-q", "main");
    repo.write("src/a.ts", "main");
    repo.commitAll();
    expect(() => repo.git("merge", "-q", "other")).toThrow();
    const before = repo.indexBytes();

    const { tree } = takeSnapshot(repo.root, [["src/**"]]);

    expect(repo.indexBytes()).toEqual(before);
    expect(repo.git("ls-tree", "-r", "--name-only", tree)).toContain("src/a.ts");
  });

  it("まだ 1 度もコミットしていないリポジトリでも取れる", () => {
    const empty = createRepo();
    try {
      empty.write("a.txt", "a");

      const { tree } = takeSnapshot(empty.root, [["**"]]);

      expect(empty.git("ls-tree", "-r", "--name-only", tree).trim()).toBe("a.txt");
      expect(empty.indexBytes()).toBeUndefined();
    } finally {
      empty.cleanup();
    }
  });
});

describe("後片付け", () => {
  function filesInGitDir() {
    const gitDir = repo.git("rev-parse", "--path-format=absolute", "--git-dir").trim();
    return readdirSync(gitDir, { recursive: true }).map(String).sort();
  }

  it("取り終えたら、git ディレクトリに作業用のファイルを残さない", () => {
    takeSnapshot(repo.root, [["src/**"]]);
    const before = filesInGitDir();

    takeSnapshot(repo.root, [["src/**"]]);

    expect(filesInGitDir()).toEqual(before);
  });

  it("git が失敗しても、作業用のファイルを残さない", () => {
    takeSnapshot(repo.root, [["src/**"]]);
    const before = filesInGitDir();

    expect(() => takeSnapshot(repo.root, [[":(unknown-magic)src"]])).toThrow();

    expect(filesInGitDir()).toEqual(before);
  });
});

describe("paths の解釈", () => {
  it("サブディレクトリを渡しても、paths はリポジトリのルートから数える", () => {
    const fromRoot = takeSnapshot(repo.root, [["src/**"]]);
    const fromSub = takeSnapshot(join(repo.root, "src"), [["src/**"]]);

    expect(fromSub).toEqual(fromRoot);
  });

  it("呼び出し元の GIT_INDEX_FILE や pathspec の環境変数に左右されない", () => {
    const expected = takeSnapshot(repo.root, [["src/*"], ["*.md"]]);
    vi.stubEnv("GIT_INDEX_FILE", join(repo.root, "elsewhere-index"));
    vi.stubEnv("GIT_LITERAL_PATHSPECS", "1");
    vi.stubEnv("GIT_ICASE_PATHSPECS", "1");

    expect(takeSnapshot(repo.root, [["src/*"], ["*.md"]])).toEqual(expected);
  });

  it("paths の組ごとに、渡した順で結果を返す", () => {
    const { files } = takeSnapshot(repo.root, [["src/**"], ["*.md"], ["src/**"]]);

    expect(files).toHaveLength(3);
    expect(files[0]).toContain("src/a.ts");
    expect(files[0]).not.toContain("README.md");
    expect(files[1]).toContain("README.md");
    expect(files[2]).toBe(files[0]);
  });
});
