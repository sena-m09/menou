import * as v from "valibot";
import type { GateResult } from "./gate";

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

const StopInputSchema = v.object({
  session_id: v.string(),
  prompt_id: v.fallback(v.optional(v.string()), undefined),
});

export type StopHookInput =
  | { status: "ok"; sessionId: string; promptId: string | undefined }
  | { status: "invalid"; problem: string };

export function readStopInput(text: string): StopHookInput {
  const json = v.safeParse(v.pipe(v.string(), v.parseJson()), text);
  if (!json.success) {
    return { status: "invalid", problem: "フックの入力を JSON として読めませんでした。" };
  }
  const input = v.safeParse(StopInputSchema, json.output);
  if (!input.success) {
    return { status: "invalid", problem: "フックの入力に session_id の文字列がありません。" };
  }
  return { status: "ok", sessionId: input.output.session_id, promptId: input.output.prompt_id };
}

export interface StopOutput {
  decision?: "block";
  reason?: string;
  systemMessage?: string;
}

export function stopOutput(result: GateResult): StopOutput {
  switch (result.decision) {
    case "block":
      return {
        decision: "block",
        reason: result.reason,
        ...(result.notice === undefined ? {} : noticeOutput(result.notice)),
      };
    case "pass":
      return result.notice === undefined ? {} : noticeOutput(result.notice);
    case "limit":
      return noticeOutput(result.notice);
  }
}

export function noticeOutput(notice: string): StopOutput {
  return { systemMessage: notice };
}

export function sessionIdFromEnv(env: NodeJS.ProcessEnv): string | undefined {
  return env.CLAUDE_CODE_SESSION_ID;
}
