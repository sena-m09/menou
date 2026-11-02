import { version } from "../package.json";

export interface Output {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

const subcommands = new Set(["hook", "run", "status"]);

export function run(args: readonly string[], output: Output): number {
  const [command] = args;

  if (command === "--version") {
    output.stdout(`${version}\n`);
    return 0;
  }

  if (command !== undefined && subcommands.has(command)) {
    return 0;
  }

  output.stderr(
    `menou: 知らないサブコマンドです: ${command ?? "（なし）"}\n使えるサブコマンド: ${[...subcommands].join(", ")}\n`,
  );
  return 1;
}
