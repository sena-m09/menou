import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as v from "valibot";
import { git } from "./git";
import { removeStaleTemporaries, temporaryName } from "./temp-file";

const ErrorCauseSchema = v.variant("kind", [
  v.object({ kind: v.literal("exit"), code: v.number() }),
  v.object({ kind: v.literal("signal"), signal: v.string() }),
  v.object({ kind: v.literal("timeout"), seconds: v.number() }),
  v.object({ kind: v.literal("spawn"), message: v.string() }),
  v.object({ kind: v.literal("modified") }),
]);

const OutcomeSchema = v.variant("result", [
  v.object({ result: v.literal("pass") }),
  v.object({ result: v.literal("fail") }),
  v.object({ result: v.literal("error"), cause: ErrorCauseSchema }),
]);

const CheckRecordSchema = v.intersect([
  v.object({
    id: v.string(),
    fingerprint: v.string(),
    finishedAt: v.string(),
    gitDir: v.optional(v.string()),
  }),
  OutcomeSchema,
]);

const RecordFileSchema = v.pipe(v.string(), v.parseJson(), CheckRecordSchema);

export type ErrorCause = v.InferOutput<typeof ErrorCauseSchema>;
export type Outcome = v.InferOutput<typeof OutcomeSchema>;
export type CheckRecord = v.InferOutput<typeof CheckRecordSchema>;

export interface Locations {
  root: string;
  gitDir: string;
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
    gitDir,
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
  const text = readText(recordPath(locations, id, fingerprint));
  if (text === undefined) return undefined;
  const result = v.safeParse(RecordFileSchema, text);
  if (!result.success || result.output.id !== id || result.output.fingerprint !== fingerprint) {
    return undefined;
  }
  return result.output;
}

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

export function prepareOutDir(locations: Locations, id: string): string {
  const dir = join(locations.worktreeDir, "out", id);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}
