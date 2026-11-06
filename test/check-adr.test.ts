import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, onTestFinished } from "vitest";

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

function git(repo: string, ...args: string[]) {
  execFileSync("git", args, { cwd: repo, stdio: "ignore" });
}

function write(repo: string, path: string, text: string) {
  const full = join(repo, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, text);
}

function edit(repo: string, path: string, from: string, to: string) {
  const full = join(repo, path);
  const text = readFileSync(full, "utf8");
  expect(text).toContain(from);
  writeFileSync(full, text.replace(from, to));
}

function commitAll(repo: string, message: string) {
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", message);
}

function check(repo: string) {
  const result = spawnSync(process.execPath, [script], { cwd: repo, encoding: "utf8" });
  return { status: result.status, stderr: result.stderr };
}

describe("マージ済みの ADR の確認", () => {
  it("何も変えていなければ通る", () => {
    const repo = mkdtempSync(join(tmpdir(), "menou-adr-"));
    onTestFinished(() => rmSync(repo, { recursive: true, force: true }));
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.name", "test");
    git(repo, "config", "user.email", "test@example.com");
    git(repo, "config", "commit.gpgsign", "false");
    write(repo, adr, adrText);
    write(repo, "docs/adr/template.md", "# タイトル\n");
    commitAll(repo, "ADR を足す");
    git(repo, "switch", "-q", "-c", "feature");

    expect(check(repo).status).toBe(0);
  });

  it.each([
    ["本文", "決定の本文", "書き換えた決定"],
    ["タイトル", "# サンプルの決定", "# 別のタイトル"],
    ["日付", "- 日付：2026-11-01", "- 日付：2026-11-04"],
  ])("%sを変えると失敗し、新しい ADR を書いて置き換える手順を案内する", (_, from, to) => {
    const repo = mkdtempSync(join(tmpdir(), "menou-adr-"));
    onTestFinished(() => rmSync(repo, { recursive: true, force: true }));
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.name", "test");
    git(repo, "config", "user.email", "test@example.com");
    git(repo, "config", "commit.gpgsign", "false");
    write(repo, adr, adrText);
    write(repo, "docs/adr/template.md", "# タイトル\n");
    commitAll(repo, "ADR を足す");
    git(repo, "switch", "-q", "-c", "feature");

    edit(repo, adr, from, to);

    const { status, stderr } = check(repo);

    expect(status).toBe(1);
    expect(stderr).toContain(adr);
    expect(stderr).toContain("新しい ADR");
    expect(stderr).toContain("により置き換え");
  });

  it("状態の行だけを変えるのは通る", () => {
    const repo = mkdtempSync(join(tmpdir(), "menou-adr-"));
    onTestFinished(() => rmSync(repo, { recursive: true, force: true }));
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.name", "test");
    git(repo, "config", "user.email", "test@example.com");
    git(repo, "config", "commit.gpgsign", "false");
    write(repo, adr, adrText);
    write(repo, "docs/adr/template.md", "# タイトル\n");
    commitAll(repo, "ADR を足す");
    git(repo, "switch", "-q", "-c", "feature");

    edit(repo, adr, "- 状態：採用", "- 状態：20261120-next.md により置き換え");

    expect(check(repo).status).toBe(0);
  });

  it("状態の行を消すと失敗する", () => {
    const repo = mkdtempSync(join(tmpdir(), "menou-adr-"));
    onTestFinished(() => rmSync(repo, { recursive: true, force: true }));
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.name", "test");
    git(repo, "config", "user.email", "test@example.com");
    git(repo, "config", "commit.gpgsign", "false");
    write(repo, adr, adrText);
    write(repo, "docs/adr/template.md", "# タイトル\n");
    commitAll(repo, "ADR を足す");
    git(repo, "switch", "-q", "-c", "feature");

    edit(repo, adr, "- 状態：採用\n", "");

    const { status, stderr } = check(repo);

    expect(status).toBe(1);
    expect(stderr).toContain(adr);
  });

  it("コミットしたあとの書き換えも失敗する", () => {
    const repo = mkdtempSync(join(tmpdir(), "menou-adr-"));
    onTestFinished(() => rmSync(repo, { recursive: true, force: true }));
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.name", "test");
    git(repo, "config", "user.email", "test@example.com");
    git(repo, "config", "commit.gpgsign", "false");
    write(repo, adr, adrText);
    write(repo, "docs/adr/template.md", "# タイトル\n");
    commitAll(repo, "ADR を足す");
    git(repo, "switch", "-q", "-c", "feature");

    edit(repo, adr, "決定の本文", "書き換えた決定");
    commitAll(repo, "ADR を直す");

    const { status, stderr } = check(repo);

    expect(status).toBe(1);
    expect(stderr).toContain(adr);
  });

  it("消すと失敗する", () => {
    const repo = mkdtempSync(join(tmpdir(), "menou-adr-"));
    onTestFinished(() => rmSync(repo, { recursive: true, force: true }));
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.name", "test");
    git(repo, "config", "user.email", "test@example.com");
    git(repo, "config", "commit.gpgsign", "false");
    write(repo, adr, adrText);
    write(repo, "docs/adr/template.md", "# タイトル\n");
    commitAll(repo, "ADR を足す");
    git(repo, "switch", "-q", "-c", "feature");

    rmSync(join(repo, adr));

    const { status, stderr } = check(repo);

    expect(status).toBe(1);
    expect(stderr).toContain(adr);
  });

  it("名前を変えると、元の名前の ADR が消えたとして失敗する", () => {
    const repo = mkdtempSync(join(tmpdir(), "menou-adr-"));
    onTestFinished(() => rmSync(repo, { recursive: true, force: true }));
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.name", "test");
    git(repo, "config", "user.email", "test@example.com");
    git(repo, "config", "commit.gpgsign", "false");
    write(repo, adr, adrText);
    write(repo, "docs/adr/template.md", "# タイトル\n");
    commitAll(repo, "ADR を足す");
    git(repo, "switch", "-q", "-c", "feature");

    git(repo, "mv", adr, "docs/adr/20261101-renamed.md");

    const { status, stderr } = check(repo);

    expect(status).toBe(1);
    expect(stderr).toContain(adr);
  });

  it("まだ main にない ADR は、コミットしたあとでも自由に直せる", () => {
    const repo = mkdtempSync(join(tmpdir(), "menou-adr-"));
    onTestFinished(() => rmSync(repo, { recursive: true, force: true }));
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.name", "test");
    git(repo, "config", "user.email", "test@example.com");
    git(repo, "config", "commit.gpgsign", "false");
    write(repo, adr, adrText);
    write(repo, "docs/adr/template.md", "# タイトル\n");
    commitAll(repo, "ADR を足す");
    git(repo, "switch", "-q", "-c", "feature");

    write(repo, "docs/adr/20261104-draft.md", adrText);
    commitAll(repo, "書きかけの ADR");
    edit(repo, "docs/adr/20261104-draft.md", "決定の本文", "書き直した決定");

    expect(check(repo).status).toBe(0);
  });

  it("分岐したあとに main に入った ADR は、今のブランチになくても失敗しない", () => {
    const repo = mkdtempSync(join(tmpdir(), "menou-adr-"));
    onTestFinished(() => rmSync(repo, { recursive: true, force: true }));
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.name", "test");
    git(repo, "config", "user.email", "test@example.com");
    git(repo, "config", "commit.gpgsign", "false");
    write(repo, adr, adrText);
    write(repo, "docs/adr/template.md", "# タイトル\n");
    commitAll(repo, "ADR を足す");
    git(repo, "switch", "-q", "-c", "feature");

    git(repo, "switch", "-q", "main");
    write(repo, "docs/adr/20261103-later.md", adrText);
    commitAll(repo, "あとから ADR を足す");
    git(repo, "switch", "-q", "feature");

    expect(check(repo).status).toBe(0);
  });

  it("テンプレートは書き換えても通る", () => {
    const repo = mkdtempSync(join(tmpdir(), "menou-adr-"));
    onTestFinished(() => rmSync(repo, { recursive: true, force: true }));
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.name", "test");
    git(repo, "config", "user.email", "test@example.com");
    git(repo, "config", "commit.gpgsign", "false");
    write(repo, adr, adrText);
    write(repo, "docs/adr/template.md", "# タイトル\n");
    commitAll(repo, "ADR を足す");
    git(repo, "switch", "-q", "-c", "feature");

    edit(repo, "docs/adr/template.md", "# タイトル", "# 決めたこと");

    expect(check(repo).status).toBe(0);
  });

  it("main ブランチが見つからなければ、確かめられないとして失敗する", () => {
    const repo = mkdtempSync(join(tmpdir(), "menou-adr-"));
    onTestFinished(() => rmSync(repo, { recursive: true, force: true }));
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.name", "test");
    git(repo, "config", "user.email", "test@example.com");
    git(repo, "config", "commit.gpgsign", "false");
    write(repo, adr, adrText);
    write(repo, "docs/adr/template.md", "# タイトル\n");
    commitAll(repo, "ADR を足す");
    git(repo, "switch", "-q", "-c", "feature");

    git(repo, "branch", "-q", "-m", "main", "trunk");

    const { status, stderr } = check(repo);

    expect(status).toBe(1);
    expect(stderr).toContain("git fetch origin main");
  });
});
