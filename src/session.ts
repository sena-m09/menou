import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import * as v from "valibot";
import type { Locations } from "./store";
import { removeStaleTemporaries, temporaryName } from "./temp-file";

export const SessionIdSchema = v.pipe(
  v.string(),
  v.regex(/^[A-Za-z0-9_-]+$/),
  v.brand("SessionId"),
);

export type SessionId = v.InferOutput<typeof SessionIdSchema>;

const BaselineSchema = v.object({
  tree: v.string(),
  recordedAt: v.pipe(v.string(), v.isoTimestamp()),
});

const BaselineFileSchema = v.pipe(v.string(), v.parseJson(), BaselineSchema);

type Baseline = v.InferOutput<typeof BaselineSchema>;

export function parseSessionId(text: string): SessionId | undefined {
  const result = v.safeParse(SessionIdSchema, text);
  return result.success ? result.output : undefined;
}

function sessionsDir(locations: Locations): string {
  return join(locations.worktreeDir, "sessions");
}

function baselinePath(locations: Locations, sessionId: string): string {
  return join(sessionsDir(locations), sessionId, "baseline.json");
}

export function recordBaseline(
  locations: Locations,
  sessionId: SessionId,
  takeTree: () => string,
): void {
  if (existsSync(baselinePath(locations, sessionId))) return;
  const baseline: Baseline = { tree: takeTree(), recordedAt: new Date().toISOString() };
  writeSessionFile(locations, sessionId, "baseline", baseline);
}

function writeSessionFile(
  locations: Locations,
  sessionId: SessionId,
  name: string,
  content: Baseline | BlockCount,
): void {
  mkdirSync(join(sessionsDir(locations), sessionId), { recursive: true });
  removeStaleTemporaries(locations.worktreeDir, name);
  const temporary = join(locations.worktreeDir, temporaryName(name));
  try {
    writeFileSync(temporary, `${JSON.stringify(content)}\n`);
    renameSync(temporary, join(sessionsDir(locations), sessionId, `${name}.json`));
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function readBaselineTree(locations: Locations, sessionId: SessionId): string | undefined {
  return readBaseline(locations, sessionId)?.tree;
}

export function selectBaseline(
  locations: Locations,
  sessionId: string | undefined,
): string | undefined {
  const ownId = sessionId === undefined ? undefined : parseSessionId(sessionId);
  const own = ownId === undefined ? undefined : readBaseline(locations, ownId);
  return (own ?? latestBaseline(locations))?.tree;
}

function latestBaseline(locations: Locations): Baseline | undefined {
  return listSessions(locations)
    .toSorted()
    .flatMap((name) => {
      const id = parseSessionId(name);
      const baseline = id === undefined ? undefined : readBaseline(locations, id);
      return baseline === undefined ? [] : [baseline];
    })
    .reduce<Baseline | undefined>(
      (latest, baseline) =>
        latest === undefined || Date.parse(baseline.recordedAt) > Date.parse(latest.recordedAt)
          ? baseline
          : latest,
      undefined,
    );
}

function listSessions(locations: Locations): string[] {
  try {
    return readdirSync(sessionsDir(locations));
  } catch {
    return [];
  }
}

function readBaseline(locations: Locations, sessionId: SessionId): Baseline | undefined {
  try {
    const result = v.safeParse(
      BaselineFileSchema,
      readFileSync(baselinePath(locations, sessionId), "utf8"),
    );
    return result.success ? result.output : undefined;
  } catch {
    return undefined;
  }
}

const BlockCountSchema = v.object({
  count: v.pipe(v.number(), v.integer(), v.minValue(0)),
  promptId: v.optional(v.string()),
});

const BlockCountFileSchema = v.pipe(v.string(), v.parseJson(), BlockCountSchema);

export type BlockCount = v.InferOutput<typeof BlockCountSchema>;

export type StopDecision = "pass" | "block" | "limit";

export interface StopFacts {
  promptId: string | undefined;
  short: boolean;
  maxBlocks: number;
}

export function countBlock(
  previous: BlockCount,
  stop: StopFacts,
): { decision: StopDecision; next: BlockCount } {
  if (!stop.short) return { decision: "pass", next: { count: 0 } };
  const count = previous.promptId === stop.promptId ? previous.count : 0;
  if (count >= stop.maxBlocks) return { decision: "limit", next: previous };
  return { decision: "block", next: { count: count + 1, promptId: stop.promptId } };
}

export function readBlockCount(locations: Locations, sessionId: SessionId): BlockCount {
  try {
    const result = v.safeParse(
      BlockCountFileSchema,
      readFileSync(join(sessionsDir(locations), sessionId, "blocks.json"), "utf8"),
    );
    return result.success ? result.output : { count: 0 };
  } catch {
    return { count: 0 };
  }
}

export function writeBlockCount(
  locations: Locations,
  sessionId: SessionId,
  count: BlockCount,
): void {
  writeSessionFile(locations, sessionId, "blocks", count);
}
