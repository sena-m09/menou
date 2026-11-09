import { join } from "node:path";
import { type Problem, configFileName } from "./config";
import type { CheckEvaluation } from "./gate";
import type { ErrorCause, Locations } from "./store";

export function blockReason(blocking: readonly CheckEvaluation[], locations: Locations): string {
  return [
    "menou: 完了する前に、次のチェックを満たしてください。",
    ...blocking.map((evaluation) => `- ${instruction(evaluation, locations)}`),
  ].join("\n");
}

export function warnNotice(warnings: readonly CheckEvaluation[], locations: Locations): string {
  return [
    "menou: 次の警告のチェックを満たしていません。完了は止めていません。",
    ...warnings.map((evaluation) => `- ${instruction(evaluation, locations)}`),
  ].join("\n");
}

export function limitNotice(
  blocking: readonly CheckEvaluation[],
  warnings: readonly CheckEvaluation[],
  maxBlocks: number,
  locations: Locations,
): string {
  return [
    `menou: 同じ依頼の中で ${maxBlocks} 回続けてブロックしたので、次のチェックを満たさないまま完了を許可しました。内容を確かめてください。`,
    ...blocking.map((evaluation) => `- ${instruction(evaluation, locations)}`),
    ...(warnings.length > 0 ? ["警告のチェックも満たしていません。"] : []),
    ...warnings.map((evaluation) => `- ${instruction(evaluation, locations)}`),
  ].join("\n");
}

export function invalidConfigReason(problems: readonly Problem[]): string {
  return [
    `menou: ${configFileName} が不正なので、完了してよいかを判定できません。${configFileName} は直さずに作業を止め、次の箇所を直すよう利用者に伝えてください。`,
    problemLines(problems),
  ].join("\n");
}

export function invalidConfigLimitNotice(problems: readonly Problem[], maxBlocks: number): string {
  return [
    `menou: ${configFileName} が不正なまま ${maxBlocks} 回続けてブロックしたので、チェックをせずに完了を許可しました。次の箇所を直してください。`,
    problemLines(problems),
  ].join("\n");
}

export function problemLines(problems: readonly Problem[]): string {
  return problems
    .map((problem) => `  ${problem.path === "" ? "" : `${problem.path}: `}${problem.message}`)
    .join("\n");
}

function instruction({ check, state }: CheckEvaluation, locations: Locations): string {
  const hint = check.hint === undefined ? "" : `補足: ${check.hint}`;
  return `${what(check.id, state, locations)}${hint}`;
}

function what(id: string, state: CheckEvaluation["state"], locations: Locations): string {
  const run = `\`menou run ${id}\``;
  switch (state.kind) {
    case "out-of-scope":
    case "recorded-pass":
      return `${id} は満たしています。`;
    case "ran":
      switch (state.outcome.result) {
        case "pass":
          return `${id} は合格しました。`;
        case "fail":
          return `${id} は不合格でした。${run} を実行して出力を確かめ、直してください。`;
        case "error":
          return `${id} はチェック自体のエラーで終わりました（${errorLabel(state.outcome.cause)}）。コードの不合格ではありません。${run} を実行して出力を確かめてください。`;
      }
    case "over-budget":
      return `${id} は、1 回の完了の判定で使える ${state.budgetSeconds} 秒に収まらないので、実行していません。${run} を実行してください。`;
    case "no-evidence":
      return `${id} は、今のコードで合格した記録がありません。${run} を実行してください。`;
    case "failed-evidence": {
      const { record } = state;
      if (!state.here) {
        const kind = record.result === "error" ? "エラー" : "不合格";
        return `${id} の今のコードでの記録は、別の worktree で取った${kind}の記録なので、詳細がここにありません。${run} を実行して取り直してください。`;
      }
      if (record.result === "error") {
        return `${id} は今のコードで、チェック自体のエラーになりました（${errorLabel(record.cause)}）。コードの不合格ではありません。${run} を実行して出力を確かめてください。`;
      }
      return `${id} は今のコードで不合格でした。詳細は \`${join(locations.worktreeDir, "out", id)}\` にあります。読んで直してから、${run} を実行してください。`;
    }
    case "waiting": {
      const needs = state.needs.join("・");
      return `${id} は、前提の ${needs} が通るまで確かめません。先に ${needs} を満たしてください。`;
    }
  }
}

export function errorLabel(cause: ErrorCause): string {
  switch (cause.kind) {
    case "exit":
      return `終了コード ${cause.code}`;
    case "signal":
      return `シグナル ${cause.signal}`;
    case "timeout":
      return `${cause.seconds} 秒でタイムアウト`;
    case "spawn":
      return "実行できない";
    case "modified":
      return "実行中にファイルが書き換わった";
  }
}
