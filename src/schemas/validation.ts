/**
 * Workflow validation and loading functions.
 *
 * - `validateWorkflow(raw)` — validates a parsed object against the Zod schema.
 * - `loadWorkflow(yamlString, existingNames?)` — parses YAML then validates.
 *
 * Both return a `Result<WorkflowDefinition, ValidationError[]>`.
 */

import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import type { Result } from '../utils/result.js';
import { SchemaErrorCode, type ValidationError } from './errors.js';
import { WorkflowDefinitionSchema, type WorkflowDefinition } from './workflow.schema.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Convert a Zod issue path to a human-readable dot-path string.
 * e.g., `['nodes', 'assess_intent', 'transitions', 0, 'target']`
 * → `"nodes.assess_intent.transitions[0].target"`
 *
 * Zod 4 uses `PropertyKey[]` (string | number | symbol) for paths.
 */
function formatPath(segments: PropertyKey[]): string {
  let result = '';
  for (const seg of segments) {
    if (typeof seg === 'number') {
      result += `[${String(seg)}]`;
    } else if (typeof seg === 'symbol') {
      result += result.length === 0 ? String(seg) : `.${String(seg)}`;
    } else {
      result += result.length === 0 ? seg : `.${seg}`;
    }
  }
  return result;
}

/**
 * Map a Zod issue to a `SchemaErrorCode`.
 *
 * Zod 4 issue codes:
 *   invalid_type, invalid_value, invalid_format, invalid_union,
 *   too_big, too_small, not_multiple_of, unrecognized_keys,
 *   invalid_key, invalid_element, custom
 */
function zodIssueToCode(issue: z.ZodIssue): string {
  // Custom issues carry the error code in `params.errorCode`
  if (issue.code === z.ZodIssueCode.custom && issue.params && 'errorCode' in issue.params) {
    return issue.params.errorCode as string;
  }
  // Structural mapping — missing required field
  // In Zod 4, missing fields produce `invalid_type` with message containing "required"
  // or `expected` !== received type.
  if (issue.code === z.ZodIssueCode.invalid_type) {
    // Zod 4 invalid_type: check if the message indicates a missing/undefined value
    if (issue.message.includes('required') || issue.message.includes('undefined')) {
      return SchemaErrorCode.MISSING_REQUIRED_FIELD;
    }
    return SchemaErrorCode.INVALID_FIELD_TYPE;
  }
  // Invalid value (covers Zod 3's invalid_literal, invalid_enum_value)
  if (issue.code === z.ZodIssueCode.invalid_value) {
    return SchemaErrorCode.INVALID_FIELD_TYPE;
  }
  // Invalid union (covers Zod 3's invalid_union_discriminator)
  if (issue.code === z.ZodIssueCode.invalid_union) {
    return SchemaErrorCode.INVALID_FIELD_TYPE;
  }
  // String format constraints — regex, email, etc. (Zod 4: invalid_format)
  if (issue.code === z.ZodIssueCode.invalid_format) {
    const path = formatPath(issue.path);
    if (path === 'workflow_name' || path.endsWith('workflow_name')) {
      return SchemaErrorCode.INVALID_WORKFLOW_NAME;
    }
    return SchemaErrorCode.INVALID_FIELD_TYPE;
  }
  // Size constraints (min, max)
  if (issue.code === z.ZodIssueCode.too_small || issue.code === z.ZodIssueCode.too_big) {
    const path = formatPath(issue.path);
    if (path === 'workflow_name' || path.endsWith('workflow_name')) {
      return SchemaErrorCode.INVALID_WORKFLOW_NAME;
    }
    return SchemaErrorCode.INVALID_FIELD_TYPE;
  }
  return SchemaErrorCode.INVALID_FIELD_TYPE;
}

/**
 * Transform Zod errors into our `ValidationError[]` shape.
 */
function mapZodErrors(zodError: z.ZodError): ValidationError[] {
  return zodError.issues.map((issue) => ({
    path: formatPath(issue.path),
    message: issue.message,
    code: zodIssueToCode(issue),
  }));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Validate a raw (already-parsed) object against the workflow schema.
 *
 * Returns **all** errors found (structural + cross-field) in a single pass.
 */
export function validateWorkflow(raw: unknown): Result<WorkflowDefinition, ValidationError[]> {
  const result = WorkflowDefinitionSchema.safeParse(raw);
  if (result.success) {
    return { ok: true, data: result.data };
  }
  return { ok: false, errors: mapZodErrors(result.error) };
}

/**
 * Parse a YAML string and validate the result.
 *
 * @param yamlString Raw YAML text.
 * @param existingNames Optional set of already-registered workflow names for
 *   uniqueness checking.
 */
export function loadWorkflow(
  yamlString: string,
  existingNames?: Set<string>,
): Result<WorkflowDefinition, ValidationError[]> {
  // Step 1: Parse YAML
  let raw: unknown;
  try {
    raw = parseYaml(yamlString);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Failed to parse YAML';
    return {
      ok: false,
      errors: [{ path: '', message, code: SchemaErrorCode.INVALID_YAML }],
    };
  }

  // Step 2: Schema validation
  const result = validateWorkflow(raw);

  // Step 3: Name uniqueness check (P1)
  if (result.ok && existingNames) {
    if (existingNames.has(result.data.workflow_name)) {
      return {
        ok: false,
        errors: [
          {
            path: 'workflow_name',
            message: `Workflow name "${result.data.workflow_name}" is already in use`,
            code: SchemaErrorCode.DUPLICATE_WORKFLOW_NAME,
          },
        ],
      };
    }
  }

  return result;
}
