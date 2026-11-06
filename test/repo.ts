import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export interface Repo {
  root: string;
  git(...args: string[]): string;
  write(path: string, text: string): void;
  remove(path: string): void;
  setExecutable(path: string, executable: boolean): void;
  commitAll(): void;
  indexBytes(): Buffer | undefined;
  cleanup(): void;
}

export function createRepo(): Repo {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "menou-repo-")));
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

  git("init", "-q", "-b", "main");
  git("config", "user.name", "test");
  git("config", "user.email", "test@example.com");
  git("config", "commit.gpgsign", "false");
  const index = git("rev-parse", "--path-format=absolute", "--git-path", "index").trim();

  return {
    root,
    git,
    write(path, text) {
      const full = join(root, path);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, text);
    },
    remove(path) {
      rmSync(join(root, path));
    },
    setExecutable(path, executable) {
      chmodSync(join(root, path), executable ? 0o755 : 0o644);
    },
    commitAll() {
      git("add", "-A");
      git("commit", "-q", "--no-verify", "--allow-empty", "-m", "commit");
    },
    indexBytes() {
      return existsSync(index) ? readFileSync(index) : undefined;
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}
