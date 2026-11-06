import { version } from "../package.json";
import { runCheck } from "./check-runner";
import { type CheckDefinition, type Config, configFileName, loadConfig } from "./config";
import { computeFingerprints } from "./fingerprint";
import { GitError } from "./git";
import {
  type ErrorCause,
  type Locations,
  type Outcome,
  prepareOutDir,
  resolveLocations,
  writeRecord,
} from "./store";

export interface Context {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  cwd?: string;
  checkOutput?: "inherit" | "ignore";
}

const subcommands = new Set(["hook", "run", "status"]);

const exitCodes = { pass: 0, fail: 1, error: 3 } as const;

class MenouError extends Error {}

export async function run(args: readonly string[], context: Context): Promise<number> {
  const [command, ...rest] = args;

  if (command === "--version") {
    context.stdout(`${version}\n`);
    return 0;
  }

  try {
    if (command === "run") return await runOne(rest[0], context);
  } catch (error) {
    const message =
      error instanceof MenouError || error instanceof GitError ? error.message : String(error);
    context.stderr(`menou: ${message}\n`);
    return exitCodes.error;
  }

  if (command !== undefined && subcommands.has(command)) {
    return 0;
  }

  context.stderr(
    `menou: 知らないサブコマンドです: ${command ?? "（なし）"}\n使えるサブコマンド: ${[...subcommands].join(", ")}\n`,
  );
  return 1;
}

interface Workspace {
  locations: Locations;
  config: Config;
}

function openWorkspace(context: Context): Workspace | undefined {
  let locations: Locations;
  try {
    locations = resolveLocations(context.cwd ?? process.cwd());
  } catch (error) {
    if (!(error instanceof GitError)) throw error;
    throw new MenouError("git リポジトリの中で実行してください。");
  }

  const result = loadConfig(locations.root);
  if (result.status === "missing") return undefined;
  if (result.status === "invalid") {
    const lines = result.problems.map((p) => `  ${p.path === "" ? "" : `${p.path}: `}${p.message}`);
    throw new MenouError(
      `${configFileName} が不正です。次の箇所を直してください。\n${lines.join("\n")}`,
    );
  }
  return { locations, config: result.config };
}

function idList(config: Config): string {
  return config.checks.length === 0
    ? "（なし）"
    : config.checks.map((check) => check.id).join(", ");
}

async function runOne(id: string | undefined, context: Context): Promise<number> {
  const workspace = openWorkspace(context);
  if (workspace === undefined) {
    throw new MenouError(
      `このリポジトリには ${configFileName} がありません。リポジトリのルートに置いて、チェックを書いてください。`,
    );
  }
  const { locations, config } = workspace;

  if (id === undefined) {
    throw new MenouError(
      `実行するチェックの id を渡してください: menou run <id>\n使える id: ${idList(config)}`,
    );
  }
  const check = config.checks.find((c) => c.id === id);
  if (check === undefined) {
    throw new MenouError(
      `id が "${id}" のチェックは ${configFileName} にありません。\n使える id: ${idList(config)}`,
    );
  }

  const fingerprintNow = () =>
    computeFingerprints(locations.root, [check]).fingerprints.get(check.id) ?? "";
  const before = fingerprintNow();
  const outDir = prepareOutDir(locations, check.id);
  let outcome: Outcome = await runCheck(check, {
    cwd: locations.root,
    outDir,
    stdio: context.checkOutput,
  });
  if (fingerprintNow() !== before) {
    outcome = { result: "error", cause: { kind: "modified" } };
  }

  writeRecord(locations, {
    id: check.id,
    fingerprint: before,
    finishedAt: new Date().toISOString(),
    ...outcome,
  });
  context.stderr(`menou: ${describeRun(check, outcome)}\n`);
  return exitCodes[outcome.result];
}

function describeRun(check: CheckDefinition, outcome: Outcome): string {
  switch (outcome.result) {
    case "pass":
      return `${check.id} は合格しました。`;
    case "fail":
      return `${check.id} は不合格でした。出力を見て直し、もう一度 menou run ${check.id} を実行してください。`;
    case "error":
      return describeError(check, outcome.cause);
  }
}

function describeError(check: CheckDefinition, cause: ErrorCause): string {
  switch (cause.kind) {
    case "exit":
      return cause.code === 127
        ? `${check.id} のコマンドが見つかりません（終了コード 127）。${configFileName} の run を確かめてください。`
        : `${check.id} はエラーで終わりました（終了コード ${cause.code}）。合格なら 0、不合格なら 1 で終わるよう、${configFileName} の run を確かめてください。`;
    case "signal":
      return `${check.id} はシグナル（${cause.signal}）で止まりました。もう一度 menou run ${check.id} を実行してください。`;
    case "timeout":
      return `${check.id} は ${cause.seconds} 秒で終わらなかったので止めました。チェックを速くするか、${configFileName} の timeout を延ばしてください。`;
    case "spawn":
      return `${check.id} を実行できませんでした（${cause.message}）。`;
    case "modified":
      return `${check.id} の実行中に paths の中のファイルが書き換わりました。チェックのコマンドがファイルを書き換えているなら、確かめるだけのコマンドに変えてください。`;
  }
}
