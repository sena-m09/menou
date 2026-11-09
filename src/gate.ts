import { runAndRecord } from "./check-runner";
import { type CheckDefinition, type ConfigResult, configFileName } from "./config";
import { computeFingerprints } from "./fingerprint";
import { gitQuiet } from "./git";
import {
  blockReason,
  invalidConfigLimitNotice,
  invalidConfigReason,
  limitNotice,
  warnNotice,
} from "./reason";
import {
  type SessionId,
  countBlock,
  readBaselineTree,
  readBlockCount,
  selectBaseline,
  writeBlockCount,
} from "./session";
import { type CheckRecord, type Locations, type Outcome, readRecord } from "./store";

export interface StopInput {
  locations: Locations;
  config: ConfigResult;
  sessionId: SessionId;
  promptId: string | undefined;
}

export interface GateOptions {
  budgetSeconds?: number;
}

export type CheckState =
  | { kind: "out-of-scope" }
  | { kind: "recorded-pass" }
  | { kind: "ran"; outcome: Outcome }
  | { kind: "over-budget"; budgetSeconds: number }
  | { kind: "no-evidence" }
  | { kind: "failed-evidence"; record: CheckRecord; here: boolean }
  | { kind: "waiting"; needs: string[] };

export interface CheckEvaluation {
  check: CheckDefinition;
  state: CheckState;
}

export type GateResult =
  | { decision: "pass"; checks: CheckEvaluation[]; notice?: string }
  | { decision: "block"; checks: CheckEvaluation[]; reason: string; notice?: string }
  | { decision: "limit"; checks: CheckEvaluation[]; notice: string };

export const stopBudgetSeconds = 540;

const invalidConfigMaxBlocks = 3;

export async function judgeStop(input: StopInput, options: GateOptions = {}): Promise<GateResult> {
  const startedAt = performance.now();
  const { locations, config } = input;
  if (config.status === "missing") return { decision: "pass", checks: [] };

  if (config.status === "invalid") {
    const decision = settle(input, true, invalidConfigMaxBlocks);
    switch (decision) {
      case "block":
        return { decision, checks: [], reason: invalidConfigReason(config.problems) };
      case "limit":
        return {
          decision,
          checks: [],
          notice: invalidConfigLimitNotice(config.problems, invalidConfigMaxBlocks),
        };
      case "pass":
        return { decision, checks: [] };
    }
  }

  const { checks, maxBlocks } = config.config;
  const now = computeFingerprints(locations.root, checks);
  const baseline = readBaselineTree(locations, input.sessionId);
  if (baseline === now.tree) {
    settle(input, false, maxBlocks);
    return { decision: "pass", checks: [] };
  }

  const unchanged = (tree: string, paths: readonly string[]) =>
    gitQuiet(["diff-tree", "-r", "--quiet", tree, now.tree, "--", ...paths], {
      cwd: locations.root,
      globPathspecs: true,
    });
  const comparableBaseline =
    baseline !== undefined &&
    gitQuiet(["rev-parse", "--verify", "--quiet", `${baseline}^{tree}`], {
      cwd: locations.root,
    }) &&
    unchanged(baseline, [configFileName])
      ? baseline
      : undefined;
  const inScope = (check: CheckDefinition) =>
    comparableBaseline === undefined || !unchanged(comparableBaseline, check.paths);

  const budgetSeconds = options.budgetSeconds ?? stopBudgetSeconds;
  const states = new Map<string, CheckState>();
  const evaluate = async (check: CheckDefinition): Promise<CheckState> => {
    if (!inScope(check)) return { kind: "out-of-scope" };
    const unmet = (check.needs ?? []).filter((need) => !isSatisfied(states.get(need)));
    if (unmet.length > 0) return { kind: "waiting", needs: unmet };

    const record = readRecord(locations, check.id, now.fingerprints.get(check.id) ?? "");
    if (record?.result === "pass") return { kind: "recorded-pass" };
    if (check.mode === "inline") {
      const elapsedSeconds = (performance.now() - startedAt) / 1000;
      if (elapsedSeconds + check.timeout > budgetSeconds) {
        return { kind: "over-budget", budgetSeconds };
      }
      const outcome = await runAndRecord(locations, check, {
        stdio: "ignore",
        baseline: selectBaseline(locations, input.sessionId),
        env: { MENOU_DISABLED: "1" },
      });
      return { kind: "ran", outcome };
    }
    if (record === undefined) return { kind: "no-evidence" };
    return { kind: "failed-evidence", record, here: record.gitDir === locations.gitDir };
  };

  const evaluations: CheckEvaluation[] = [];
  for (const check of needsOrder(checks)) {
    const state = await evaluate(check);
    states.set(check.id, state);
    evaluations.push({ check, state });
  }

  const short = evaluations.filter(({ state }) => !isSatisfied(state));
  const blocking = short.filter(({ check }) => check.severity === "block");
  const warnings = short.filter(({ check }) => check.severity === "warn");
  const notice = warnings.length > 0 ? warnNotice(warnings, locations) : undefined;

  const decision = settle(input, blocking.length > 0, maxBlocks);
  switch (decision) {
    case "pass":
      return { decision, checks: evaluations, notice };
    case "block":
      return { decision, checks: evaluations, reason: blockReason(blocking, locations), notice };
    case "limit":
      return {
        decision,
        checks: evaluations,
        notice: limitNotice(blocking, warnings, maxBlocks, locations),
      };
  }
}

function settle(input: StopInput, short: boolean, maxBlocks: number) {
  const previous = readBlockCount(input.locations, input.sessionId);
  const { decision, next } = countBlock(previous, { promptId: input.promptId, short, maxBlocks });
  if (next.count !== previous.count || next.promptId !== previous.promptId) {
    writeBlockCount(input.locations, input.sessionId, next);
  }
  return decision;
}

function isSatisfied(state: CheckState | undefined): boolean {
  switch (state?.kind) {
    case "out-of-scope":
    case "recorded-pass":
      return true;
    case "ran":
      return state.outcome.result === "pass";
    default:
      return false;
  }
}

function needsOrder(checks: readonly CheckDefinition[]): CheckDefinition[] {
  const byId = new Map(checks.map((check) => [check.id, check]));
  const ordered = new Map<string, CheckDefinition>();
  const visit = (check: CheckDefinition) => {
    if (ordered.has(check.id)) return;
    for (const need of check.needs ?? []) {
      const prerequisite = byId.get(need);
      if (prerequisite !== undefined) visit(prerequisite);
    }
    ordered.set(check.id, check);
  };
  checks.forEach(visit);
  return [...ordered.values()];
}
