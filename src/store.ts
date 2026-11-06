import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { git } from "./git";
import { removeStaleTemporaries, temporaryName } from "./temp-file";

export type ErrorCause =
  | { kind: "exit"; code: number }
  | { kind: "signal"; signal: string }
  | { kind: "timeout"; seconds: number }
  | { kind: "spawn"; message: string }
  | { kind: "modified" };

export type Outcome =
  | { result: "pass" }
  | { result: "fail" }
  | { result: "error"; cause: ErrorCause };

export type CheckRecord = {
  id: string;
  fingerprint: string;
  finishedAt: string;
} & Outcome;

export interface Locations {
  root: string;
  resultsDir: string;
  tempDir: string;
  worktreeDir: string;
}

export function resolveLocations(dir: string): Locations {
  const [root = "", gitDir = "", commonDir = ""] = git(
    ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-dir", "--git-common-dir"],
    { cwd: dir },
  ).split("\n");
  return {
    root,
    resultsDir: join(commonDir, "menou", "results"),
    tempDir: join(commonDir, "menou", "tmp"),
    worktreeDir: join(gitDir, "menou"),
  };
}

function recordPath(locations: Locations, id: string, fingerprint: string): string {
  return join(locations.resultsDir, id, `${fingerprint}.json`);
}

export function writeRecord(locations: Locations, record: CheckRecord): void {
  const path = recordPath(locations, record.id, record.fingerprint);
  mkdirSync(join(locations.resultsDir, record.id), { recursive: true });
  mkdirSync(locations.tempDir, { recursive: true });
  removeStaleTemporaries(locations.tempDir, "record");
  const temporary = join(locations.tempDir, temporaryName("record"));
  try {
    writeFileSync(temporary, `${JSON.stringify(record)}\n`);
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function readRecord(
  locations: Locations,
  id: string,
  fingerprint: string,
): CheckRecord | undefined {
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(recordPath(locations, id, fingerprint), "utf8"));
  } catch {
    return undefined;
  }
  return isRecord(data) && data.id === id && data.fingerprint === fingerprint ? data : undefined;
}

function isRecord(data: unknown): data is CheckRecord {
  if (typeof data !== "object" || data === null) return false;
  const record = data as Record<string, unknown>;
  if (typeof record.id !== "string" || typeof record.fingerprint !== "string") return false;
  if (typeof record.finishedAt !== "string") return false;
  if (record.result === "pass" || record.result === "fail") return true;
  return record.result === "error" && typeof record.cause === "object" && record.cause !== null;
}

export function prepareOutDir(locations: Locations, id: string): string {
  const dir = join(locations.worktreeDir, "out", id);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}
