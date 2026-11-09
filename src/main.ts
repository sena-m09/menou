import { text as readAll } from "node:stream/consumers";
import { run } from "./cli";

void run(process.argv.slice(2), {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  env: process.env,
  readStdin: () => readAll(process.stdin),
}).then((code) => {
  process.exitCode = code;
});
