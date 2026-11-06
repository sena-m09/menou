import { randomBytes } from "node:crypto";
import { type Stats, copyFileSync, mkdirSync, rmSync, statSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { git } from "./git";

export interface Snapshot {
  tree: string;
  files: string[];
}

export function takeSnapshot(dir: string, pathsList: readonly (readonly string[])[]): Snapshot {
  const [root = "", gitDir = "", realIndex = ""] = git(
    ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-dir", "--git-path", "index"],
    { cwd: dir },
  ).split("\n");

  const workDir = join(gitDir, "menou");
  mkdirSync(workDir, { recursive: true });
  const indexFile = join(workDir, `index-${process.pid}-${randomBytes(6).toString("hex")}`);

  try {
    copyRealIndex(realIndex, indexFile);
    const options = { cwd: root, indexFile };
    git(["add", "-A"], options);
    const tree = git(["write-tree"], options).trim();
    const files = pathsList.map((paths) =>
      git(["ls-files", "-s", "-z", "--", ...paths], { ...options, globPathspecs: true }),
    );
    return { tree, files };
  } finally {
    rmSync(indexFile, { force: true });
    rmSync(`${indexFile}.lock`, { force: true });
  }
}

function copyRealIndex(from: string, to: string) {
  let original: Stats;
  try {
    // 写したあとに取ると、その間に差し替わったインデックスより新しい時刻を付けてしまう。
    original = statSync(from);
    copyFileSync(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return;
  }
  // git はインデックスの mtime と同じ秒に書き換えたファイルだけ中身を見直すので、写した時刻のままだと見落とす。
  utimesSync(to, original.atime, original.mtime);
}
