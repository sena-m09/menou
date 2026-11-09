import { spawnSync } from "node:child_process";

export interface GitOptions {
  cwd: string;
  indexFile?: string;
  globPathspecs?: boolean;
}

export class GitError extends Error {
  constructor(
    readonly args: readonly string[],
    readonly stderr: string,
  ) {
    super(`git ${args.join(" ")} が失敗しました: ${stderr.trim()}`);
  }
}

const inheritedPathspecVariables = [
  "GIT_GLOB_PATHSPECS",
  "GIT_NOGLOB_PATHSPECS",
  "GIT_LITERAL_PATHSPECS",
  "GIT_ICASE_PATHSPECS",
];

export function git(args: readonly string[], options: GitOptions): string {
  const result = spawnGit(args, options);
  if (result.status !== 0) throw new GitError(args, result.stderr);
  return result.stdout;
}

export function gitQuiet(args: readonly string[], options: GitOptions): boolean {
  const result = spawnGit(args, options);
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  throw new GitError(args, result.stderr);
}

function spawnGit(args: readonly string[], options: GitOptions) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.GIT_INDEX_FILE;
  for (const name of inheritedPathspecVariables) delete env[name];
  if (options.indexFile !== undefined) env.GIT_INDEX_FILE = options.indexFile;
  if (options.globPathspecs) env.GIT_GLOB_PATHSPECS = "1";

  const result = spawnSync("git", args, {
    cwd: options.cwd,
    env,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  return result;
}
