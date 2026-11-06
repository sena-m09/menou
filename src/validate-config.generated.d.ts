import type { ErrorObject } from "ajv";

export interface ValidateConfig {
  (data: unknown): boolean;
  errors: ErrorObject[] | null;
}

declare const validate: ValidateConfig;
export default validate;
