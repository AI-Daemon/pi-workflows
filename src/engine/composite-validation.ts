/**
 * Composite validation — chains schema validation (Story #2) with
 * expression syntax validation (Story #4) and graph structural
 * validation (Story #3) in a single call.
 *
 * ```ts
 * const result = validateWorkflowFull(yamlString);
 * if (result.ok) {
 *   // result.data has both the parsed definition AND the DAGGraph
 * }
 * ```
 */

import type { WorkflowDefinition } from '../schemas/workflow.schema.js';
import type { ValidationError } from '../schemas/errors.js';
import { SchemaErrorCode } from '../schemas/errors.js';
import type { DAGGraph, GraphValidationError, GraphValidationWarning } from './dag-graph.js';
import type { Result } from '../utils/result.js';
import { loadWorkflow } from '../schemas/validation.js';
import { DAGParser, type DAGParserOptions } from './dag-parser.js';
import { ExpressionEvaluator } from './expression-evaluator.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A fully-validated workflow with both schema and graph validation passed. */
export interface ValidatedWorkflow {
  /** The schema-validated workflow definition. */
  definition: WorkflowDefinition;
  /** The parsed DAG graph representation. */
  graph: DAGGraph;
  /** Warnings from graph validation (no errors if we got here). */
  warnings: GraphValidationWarning[];
}

/** Union error type covering both schema and graph errors. */
export type CompositeValidationError = ValidationError | (GraphValidationError & { path?: string });

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Validate a YAML workflow string end-to-end:
 * 1. Parse YAML
 * 2. Schema validation (Zod)
 * 3. Expression syntax validation (all condition strings)
 * 4. Graph structural validation (cycle, reachability, etc.)
 *
 * Returns `ok: true` only if **all** stages pass.
 */
export function validateWorkflowFull(
  yamlString: string,
  options?: DAGParserOptions,
): Result<ValidatedWorkflow, CompositeValidationError[]> {
  // Step 1+2: YAML parse + schema validation
  const schemaResult = loadWorkflow(yamlString);
  if (!schemaResult.ok) {
    return { ok: false, errors: schemaResult.errors };
  }

  // Step 3: Validate all condition expression syntax
  const expressionErrors = validateExpressionSyntax(schemaResult.data);
  if (expressionErrors.length > 0) {
    return { ok: false, errors: expressionErrors };
  }

  // Step 4: Graph structural validation
  const parser = new DAGParser(schemaResult.data, options);
  const graphResult = parser.validate();
  const graph = parser.parse();

  if (!graphResult.valid) {
    return { ok: false, errors: graphResult.errors };
  }

  return {
    ok: true,
    data: {
      definition: schemaResult.data,
      graph,
      warnings: graphResult.warnings,
    },
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Validate all condition expression strings in a workflow definition.
 *
 * Iterates every non-terminal node's transitions and checks that each
 * `condition` string is syntactically valid jexl.
 */
function validateExpressionSyntax(definition: WorkflowDefinition): ValidationError[] {
  const evaluator = new ExpressionEvaluator();
  const errors: ValidationError[] = [];

  for (const [nodeKey, node] of Object.entries(definition.nodes)) {
    if (node.type === 'terminal') continue;

    for (let i = 0; i < node.transitions.length; i++) {
      const transition = node.transitions[i];
      if (!transition) continue;

      const result = evaluator.validateSyntax(transition.condition);
      if (!result.ok) {
        errors.push({
          path: `nodes.${nodeKey}.transitions[${i}].condition`,
          message: result.errors.message,
          code: SchemaErrorCode.INVALID_EXPRESSION_SYNTAX,
        });
      }
    }
  }

  return errors;
}
