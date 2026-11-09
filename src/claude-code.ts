import * as v from "valibot";

const SessionStartInputSchema = v.object({ session_id: v.string() });

export type SessionStartInput =
  | { status: "ok"; sessionId: string }
  | { status: "invalid"; problem: string };

export function readSessionStartInput(text: string): SessionStartInput {
  const json = v.safeParse(v.pipe(v.string(), v.parseJson()), text);
  if (!json.success) {
    return { status: "invalid", problem: "フックの入力を JSON として読めませんでした。" };
  }
  const input = v.safeParse(SessionStartInputSchema, json.output);
  if (!input.success) {
    return { status: "invalid", problem: "フックの入力に session_id の文字列がありません。" };
  }
  return { status: "ok", sessionId: input.output.session_id };
}

export function sessionIdFromEnv(env: NodeJS.ProcessEnv): string | undefined {
  return env.CLAUDE_CODE_SESSION_ID;
}
