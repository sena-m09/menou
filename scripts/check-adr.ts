import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const adrDir = "docs/adr";
const template = `${adrDir}/template.md`;
const statusLine = /^- 状態：.*$/gm;

function git(args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}

function findBase(): string | undefined {
  for (const ref of ["origin/main", "main"]) {
    try {
      return git(["merge-base", "HEAD", ref]).trim();
    } catch {
      continue;
    }
  }
  return undefined;
}

function withoutStatus(text: string): string {
  return text.replace(statusLine, "- 状態：");
}

const root = git(["rev-parse", "--show-toplevel"]).trim();
const base = findBase();

if (base === undefined) {
  process.stderr.write(
    "main ブランチが見つからないので、マージ済みの ADR が書き換えられていないかを確かめられません。\n" +
      "git fetch origin main を実行してから、もう一度試してください。\n",
  );
  process.exit(1);
}

const merged = git(["ls-tree", "-r", "-z", "--name-only", base, "--", `${adrDir}/`])
  .split("\0")
  .filter((path) => path !== "" && path !== template);

const problems: string[] = [];
for (const path of merged) {
  const file = join(root, path);
  if (!existsSync(file)) {
    problems.push(`${path} が消えているか、名前が変わっています。`);
    continue;
  }
  const before = git(["show", `${base}:${path}`]);
  if (withoutStatus(readFileSync(file, "utf8")) !== withoutStatus(before)) {
    problems.push(`${path} の状態の行のほかが書き換えられています。`);
  }
}

if (problems.length > 0) {
  process.stderr.write(
    [
      "main にマージ済みの ADR は、状態の行のほかは書き換えられません。",
      ...problems.map((problem) => `  ${problem}`),
      "変更を元に戻してください。",
      "決定を変えるときは新しい ADR を書き、古い ADR の状態の行を「20261120-xxx.md により置き換え」のように書き換えてください。",
      "",
    ].join("\n"),
  );
  process.exit(1);
}
