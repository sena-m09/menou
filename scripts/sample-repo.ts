import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

type SampleFile = { path: string; content: string };

const menouBin = fileURLToPath(new URL("../bin/menou", import.meta.url));
const built = fileURLToPath(new URL("../dist/menou.cjs", import.meta.url));

function json(value: object): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function hookCommand(event: string): string {
  return `'${menouBin}' hook ${event}`;
}

const lintScript = `import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)],
  );
}

try {
  const problems = files("src").flatMap((file) =>
    readFileSync(file, "utf8")
      .split("\\n")
      .flatMap((line, index) =>
        line.includes("console.log") ? [\`\${file}:\${index + 1}: console.log が残っています\\n\`] : [],
      ),
  );
  process.stdout.write(problems.join(""));
  process.exit(problems.length > 0 ? 1 : 0);
} catch (error) {
  process.stderr.write(\`src/ を読めませんでした: \${error}\\n\`);
  process.exit(2);
}
`;

const projectFiles: SampleFile[] = [
  {
    path: ".menou.json",
    content: json({
      checks: [
        {
          id: "lint",
          mode: "inline",
          run: "node scripts/no-console.mjs",
          paths: ["src/**", "scripts/no-console.mjs"],
          timeout: 30,
        },
      ],
    }),
  },
  { path: "package.json", content: json({ name: "menou-sample", private: true, type: "module" }) },
  { path: "scripts/no-console.mjs", content: lintScript },
  { path: "src/app.js", content: "export function add(a, b) {\n  return a + b;\n}\n" },
  { path: "docs/README.md", content: "# menou-sample\n\n足し算の関数を置いたサンプルです。\n" },
];

function claudeCodeFiles(): SampleFile[] {
  const hook = (event: string) => [{ hooks: [{ type: "command", command: hookCommand(event) }] }];
  return [
    {
      path: ".claude/settings.json",
      content: json({ hooks: { SessionStart: hook("session-start"), Stop: hook("stop") } }),
    },
  ];
}

const agentFiles = [claudeCodeFiles];

if (!existsSync(built)) {
  process.stderr.write(
    `${built} がありません。pnpm build を実行してから、もう一度試してください。\n`,
  );
  process.exit(1);
}
if (menouBin.includes("'")) {
  process.stderr.write(
    `${menouBin} のパスに ' が含まれていて、フックのコマンドに書けません。' を含まない場所に置いてから試してください。\n`,
  );
  process.exit(1);
}

const root = realpathSync(mkdtempSync(join(tmpdir(), "menou-sample-")));

for (const file of [...projectFiles, ...agentFiles.flatMap((files) => files())]) {
  const full = join(root, file.path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, file.content);
}

function git(args: string[]) {
  execFileSync("git", args, { cwd: root, stdio: "ignore" });
}

git(["init", "-q", "-b", "main"]);
git(["add", "-A"]);
git([
  "-c",
  "user.name=menou-sample",
  "-c",
  "user.email=menou-sample@example.invalid",
  "-c",
  "commit.gpgsign=false",
  "commit",
  "-q",
  "-m",
  "最初のコミット",
]);

process.stdout.write(`${root}\n`);
