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

const SessionIdSchema = v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]+$/), v.brand("SessionId"));

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
  const path = baselinePath(locations, sessionId);
  if (existsSync(path)) return;
  const tree = takeTree();
  const baseline: Baseline = { tree, recordedAt: new Date().toISOString() };
  mkdirSync(join(sessionsDir(locations), sessionId), { recursive: true });
  removeStaleTemporaries(locations.worktreeDir, "baseline");
  const temporary = join(locations.worktreeDir, temporaryName("baseline"));
  try {
    writeFileSync(temporary, `${JSON.stringify(baseline)}\n`);
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
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
