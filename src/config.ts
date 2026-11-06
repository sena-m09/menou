import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ErrorObject } from "ajv";
import validate from "./validate-config.generated";

export interface CheckDefinition {
  id: string;
  mode: "inline" | "evidence";
  run: string;
  paths: readonly string[];
  needs?: readonly string[];
  severity: "block" | "warn";
  timeout: number;
  hint?: string;
}

export interface Config {
  $schema?: string;
  maxBlocks: number;
  checks: readonly CheckDefinition[];
}

export interface Problem {
  path: string;
  message: string;
}

export type ParsedConfig =
  | { status: "loaded"; config: Config }
  | { status: "invalid"; kind: "json" | "schema" | "rules"; problems: Problem[] };

export type ConfigResult = { status: "missing" } | ParsedConfig;

export const configFileName = ".menou.json";

export function loadConfig(root: string): ConfigResult {
  let text: string;
  try {
    text = readFileSync(join(root, configFileName), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { status: "missing" };
    }
    throw error;
  }
  return parseConfig(text);
}

export function parseConfig(text: string): ParsedConfig {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      status: "invalid",
      kind: "json",
      problems: [
        {
          path: "",
          message: `JSON として読めません（${detail}）。カンマや引用符が抜けていないか確かめてください。`,
        },
      ],
    };
  }

  if (!validate(data)) {
    return { status: "invalid", kind: "schema", problems: (validate.errors ?? []).map(describe) };
  }

  const config = data as Config;
  const problems = checkRelations(config.checks);
  if (problems.length > 0) {
    return { status: "invalid", kind: "rules", problems };
  }
  return { status: "loaded", config };
}

const typeNames: Record<string, string> = {
  string: "文字列",
  integer: "整数",
  array: "配列",
  object: "オブジェクト",
};

function describe(error: ErrorObject): Problem {
  const path = toPath(error.instancePath);
  const params = error.params as Record<string, unknown>;
  switch (error.keyword) {
    case "required":
      return {
        path: child(path, String(params.missingProperty)),
        message: "必須のキーがありません。書き足してください。",
      };
    case "additionalProperties":
      return {
        path: child(path, String(params.additionalProperty)),
        message: "知らないキーです。綴りを確かめるか、消してください。",
      };
    case "type":
      return {
        path,
        message: `${typeNames[String(params.type)] ?? params.type}で書いてください。`,
      };
    case "enum":
      return {
        path,
        message: `${(params.allowedValues as unknown[]).map((value) => JSON.stringify(value)).join(" か ")} のどちらかを書いてください。`,
      };
    case "minimum":
      return { path, message: `${params.limit} 以上の整数を書いてください。` };
    case "minItems":
      return {
        path,
        message: '1 件以上書いてください。全ファイルを対象にするときは ["**"] と書きます。',
      };
    case "minLength":
      return {
        path,
        message: path.endsWith(".run")
          ? "空にはできません。実行するコマンドを書いてください。"
          : '空にはできません。全ファイルを対象にするときは "**" と書きます。',
      };
    case "maxLength":
      return {
        path,
        message: `${params.limit} 文字までにしてください。長い案内は別のファイルに書き、そのファイルの場所を書いてください。`,
      };
    case "pattern":
      return { path, message: "英小文字・数字・-・_ だけで書いてください。" };
    default:
      return { path, message: error.message ?? error.keyword };
  }
}

function toPath(instancePath: string): string {
  return instancePath
    .split("/")
    .slice(1)
    .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"))
    .reduce(
      (path, segment) => (/^\d+$/.test(segment) ? `${path}[${segment}]` : child(path, segment)),
      "",
    );
}

function child(path: string, key: string): string {
  return path === "" ? key : `${path}.${key}`;
}

function checkRelations(checks: readonly CheckDefinition[]): Problem[] {
  const problems: Problem[] = [];
  const firstIndex = new Map<string, number>();

  checks.forEach((check, i) => {
    const first = firstIndex.get(check.id);
    if (first === undefined) {
      firstIndex.set(check.id, i);
      return;
    }
    problems.push({
      path: `checks[${i}].id`,
      message: `id "${check.id}" は checks[${first}] でも使われています。別の id にしてください。`,
    });
  });

  checks.forEach((check, i) => {
    check.needs?.forEach((need, j) => {
      if (!firstIndex.has(need)) {
        problems.push({
          path: `checks[${i}].needs[${j}]`,
          message: `id が "${need}" のチェックはありません。id の綴りを確かめるか、needs から外してください。`,
        });
      }
    });
  });

  const graph = needsGraph(checks);
  for (const members of findNeedsCycles(checks)) {
    const [start = ""] = members;
    problems.push({
      path: `checks[${firstIndex.get(start)}].needs`,
      message: `needs が循環しています（${loopFrom(start, graph, new Set(members)).join(" → ")}）。どれかの needs を外してください。`,
    });
  }

  return problems;
}

interface NeedsNode {
  id: string;
  needs?: readonly string[];
}

function needsGraph(checks: readonly NeedsNode[]): Map<string, string[]> {
  const graph = new Map<string, string[]>(checks.map((check) => [check.id, []]));
  for (const check of checks) {
    for (const need of check.needs ?? []) {
      if (graph.has(need)) {
        graph.get(check.id)?.push(need);
      }
    }
  }
  return graph;
}

export function findNeedsCycles(checks: readonly NeedsNode[]): string[][] {
  const graph = needsGraph(checks);
  const order = [...graph.keys()];
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const cycles: string[][] = [];

  const visit = (id: string) => {
    index.set(id, index.size);
    low.set(id, index.size - 1);
    stack.push(id);
    onStack.add(id);
    const needs = graph.get(id) ?? [];
    for (const need of needs) {
      if (!index.has(need)) {
        visit(need);
        low.set(id, Math.min(low.get(id) ?? 0, low.get(need) ?? 0));
      } else if (onStack.has(need)) {
        low.set(id, Math.min(low.get(id) ?? 0, index.get(need) ?? 0));
      }
    }
    if (low.get(id) !== index.get(id)) return;

    const members: string[] = [];
    let member: string | undefined;
    do {
      member = stack.pop();
      if (member === undefined) break;
      onStack.delete(member);
      members.push(member);
    } while (member !== id);
    if (members.length > 1 || needs.includes(id)) {
      cycles.push(members.sort((a, b) => order.indexOf(a) - order.indexOf(b)));
    }
  };

  for (const id of order) {
    if (!index.has(id)) visit(id);
  }
  return cycles.sort((a, b) => order.indexOf(a[0] ?? "") - order.indexOf(b[0] ?? ""));
}

function loopFrom(start: string, graph: Map<string, string[]>, members: Set<string>): string[] {
  const previous = new Map<string, string>();
  const queue = [start];
  for (const id of queue) {
    for (const need of graph.get(id) ?? []) {
      if (need === start) {
        const loop = [start];
        for (let at = id; at !== start; at = previous.get(at) ?? start) {
          loop.splice(1, 0, at);
        }
        return [...loop, start];
      }
      if (members.has(need) && !previous.has(need)) {
        previous.set(need, id);
        queue.push(need);
      }
    }
  }
  return [start, start];
}
