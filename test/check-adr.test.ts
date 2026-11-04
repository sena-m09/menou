import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const script = fileURLToPath(new URL("../scripts/check-adr.ts", import.meta.url));
const adr = "docs/adr/20261101-sample.md";
const adrText = `# サンプルの決定

- 日付：2026-11-01
- 状態：採用

## 背景

背景の本文

## 決定

決定の本文
`;

let repo: string;

function git(...args: string[]) {
  execFileSync("git", args, { cwd: repo, stdio: "ignore" });
}

function write(path: string, text: string) {
  const full = join(repo, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, text);
}

function edit(path: string, from: string, to: string) {
  const full = join(repo, path);
  const text = readFileSync(full, "utf8");
  expect(text).toContain(from);
  writeFileSync(full, text.replace(from, to));
}

function commitAll(message: string) {
  git("add", "-A");
  git("commit", "-q", "-m", message);
}

function check() {
  const result = spawnSync(process.execPath, [script], { cwd: repo, encoding: "utf8" });
  return { status: result.status, stderr: result.stderr };
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "menou-adr-"));
  git("init", "-q", "-b", "main");
  git("config", "user.name", "test");
  git("config", "user.email", "test@example.com");
  git("config", "commit.gpgsign", "false");
  write(adr, adrText);
  write("docs/adr/template.md", "# タイトル\n");
  commitAll("ADR を足す");
  git("switch", "-q", "-c", "feature");
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("マージ済みの ADR の確認", () => {
  it("何も変えていなければ通る", () => {
    expect(check().status).toBe(0);
  });

  it.each([
    ["本文", "決定の本文", "書き換えた決定"],
    ["タイトル", "# サンプルの決定", "# 別のタイトル"],
    ["日付", "- 日付：2026-11-01", "- 日付：2026-11-04"],
  ])("%sを変えると失敗し、新しい ADR を書いて置き換える手順を案内する", (_, from, to) => {
    edit(adr, from, to);

    const { status, stderr } = check();

    expect(status).toBe(1);
    expect(stderr).toContain(adr);
    expect(stderr).toContain("新しい ADR");
    expect(stderr).toContain("により置き換え");
  });

  it("状態の行だけを変えるのは通る", () => {
    edit(adr, "- 状態：採用", "- 状態：20261120-next.md により置き換え");

    expect(check().status).toBe(0);
  });

  it("状態の行を消すと失敗する", () => {
    edit(adr, "- 状態：採用\n", "");

    const { status, stderr } = check();

    expect(status).toBe(1);
    expect(stderr).toContain(adr);
  });

  it("コミットしたあとの書き換えも失敗する", () => {
    edit(adr, "決定の本文", "書き換えた決定");
    commitAll("ADR を直す");

    const { status, stderr } = check();

    expect(status).toBe(1);
    expect(stderr).toContain(adr);
  });

  it("消すと失敗する", () => {
    rmSync(join(repo, adr));

    const { status, stderr } = check();

    expect(status).toBe(1);
    expect(stderr).toContain(adr);
  });

  it("名前を変えると、元の名前の ADR が消えたとして失敗する", () => {
    git("mv", adr, "docs/adr/20261101-renamed.md");

    const { status, stderr } = check();

    expect(status).toBe(1);
    expect(stderr).toContain(adr);
  });

  it("まだ main にない ADR は、コミットしたあとでも自由に直せる", () => {
    write("docs/adr/20261104-draft.md", adrText);
    commitAll("書きかけの ADR");
    edit("docs/adr/20261104-draft.md", "決定の本文", "書き直した決定");

    expect(check().status).toBe(0);
  });

  it("分岐したあとに main に入った ADR は、今のブランチになくても失敗しない", () => {
    git("switch", "-q", "main");
    write("docs/adr/20261103-later.md", adrText);
    commitAll("あとから ADR を足す");
    git("switch", "-q", "feature");

    expect(check().status).toBe(0);
  });

  it("テンプレートは書き換えても通る", () => {
    edit("docs/adr/template.md", "# タイトル", "# 決めたこと");

    expect(check().status).toBe(0);
  });

  it("main ブランチが見つからなければ、確かめられないとして失敗する", () => {
    git("branch", "-q", "-m", "main", "trunk");

    const { status, stderr } = check();

    expect(status).toBe(1);
    expect(stderr).toContain("git fetch origin main");
  });
});
