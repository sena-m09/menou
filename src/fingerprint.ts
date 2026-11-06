import { createHash } from "node:crypto";
import type { CheckDefinition } from "./config";
import { takeSnapshot } from "./snapshot";

export const checkFieldRoles = {
  id: "excluded",
  mode: "excluded",
  run: "included",
  paths: "included",
  needs: "excluded",
  severity: "excluded",
  timeout: "included",
  hint: "excluded",
} as const satisfies Record<keyof CheckDefinition, "included" | "excluded">;

const includedFields = (Object.keys(checkFieldRoles) as (keyof CheckDefinition)[]).filter(
  (field) => checkFieldRoles[field] === "included",
);

export function fingerprintSource(check: CheckDefinition, files: string): string {
  const definition = Object.fromEntries(includedFields.map((field) => [field, check[field]]));
  return JSON.stringify({ check: definition, files });
}

export function fingerprint(check: CheckDefinition, files: string): string {
  return createHash("sha256").update(fingerprintSource(check, files)).digest("hex");
}

export interface Fingerprints {
  tree: string;
  fingerprints: Map<string, string>;
}

export function computeFingerprints(dir: string, checks: readonly CheckDefinition[]): Fingerprints {
  const { tree, files } = takeSnapshot(
    dir,
    checks.map((check) => check.paths),
  );
  return {
    tree,
    fingerprints: new Map(checks.map((check, i) => [check.id, fingerprint(check, files[i] ?? "")])),
  };
}
