/**
 * Zod schema definitions for DAWE workflow YAML files.
 *
 * This is the **source of truth** for the workflow contract.
 * The JSON Schema (workflow.schema.json) must be kept in sync.
 *
 * Cross-field validations (initial_node existence, transition target
 * existence, terminal node requirements) are implemented via
 * `.superRefine()` on the top-level schema so that all errors are
 * collected in a single pass.
 */

import { z } from 'zod';
import { SchemaErrorCode } from './errors.js';

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

/** Transition between nodes. */
export const TransitionSchema = z
  .object({
    condition: z
      .string()
      .min(1, 'Condition expression must not be empty')
      .describe('Expression string evaluated at runtime to decide whether this transition fires'),
    // TODO: Expression syntax validation in Story #4
    target: z.string().min(1, 'Transition target must not be empty').describe('Node key this transition leads to'),
    priority: z.number().int().optional().describe('Evaluation order — lower values are evaluated first (default 0)'),
  })
  .strict()
  .describe('A conditional transition to another node');

/** Schema types allowed in required_schema / completion_schema. */
const SchemaFieldType = z.enum(['string', 'number', 'boolean', 'string[]', 'number[]']).describe('Allowed field type');
const CompletionFieldType = z.enum(['string', 'number', 'boolean']).describe('Allowed completion field type');

// ---------------------------------------------------------------------------
// Retry configuration
// ---------------------------------------------------------------------------

const RetrySchema = z
  .object({
    max_attempts: z.number().int().min(1).describe('Maximum number of retry attempts'),
    backoff_ms: z.number().int().min(0).describe('Backoff delay in milliseconds between retries'),
  })
  .strict()
  .describe('Retry configuration for LLM decision nodes');

// ---------------------------------------------------------------------------
// Node type schemas (discriminated union on `type`)
// ---------------------------------------------------------------------------

export const LlmDecisionNodeSchema = z
  .object({
    type: z.literal('llm_decision').describe('Node type: LLM-powered decision point'),
    instruction: z
      .string()
      .min(1, 'Instruction must not be empty')
      .max(2000, 'Instruction must be at most 2000 characters')
      .describe('Prompt instruction for the LLM'),
    required_schema: z
      .record(z.string(), SchemaFieldType)
      .refine((obj) => Object.keys(obj).length > 0, {
        message: 'required_schema must have at least one field',
      })
      .describe('Schema the LLM response must conform to'),
    transitions: z
      .array(TransitionSchema)
      .min(1, 'llm_decision node must have at least one transition')
      .describe('Transitions evaluated after the LLM responds'),
    timeout_seconds: z
      .number()
      .int()
      .min(5, 'timeout_seconds must be at least 5')
      .max(600, 'timeout_seconds must be at most 600')
      .default(120)
      .optional()
      .describe('Timeout in seconds (default 120)'),
    retry: RetrySchema.optional().describe('Optional retry configuration'),
  })
  .strict()
  .describe('An LLM decision node that routes based on the model response');

export const LlmTaskNodeSchema = z
  .object({
    type: z.literal('llm_task').describe('Node type: LLM-powered task'),
    instruction: z
      .string()
      .min(1, 'Instruction must not be empty')
      .max(5000, 'Instruction must be at most 5000 characters')
      .describe('Prompt instruction for the LLM task'),
    completion_schema: z.record(z.string(), CompletionFieldType).describe('Schema the LLM must return upon completion'),
    transitions: z
      .array(TransitionSchema)
      .min(1, 'llm_task node must have at least one transition')
      .describe('Transitions evaluated after the task completes'),
    timeout_seconds: z
      .number()
      .int()
      .min(10, 'timeout_seconds must be at least 10')
      .max(1800, 'timeout_seconds must be at most 1800')
      .default(300)
      .optional()
      .describe('Timeout in seconds (default 300)'),
    context_keys: z.array(z.string()).optional().describe('Payload keys to inject into the prompt context'),
  })
  .strict()
  .describe('An LLM task node that performs work and returns structured output');

export const SystemActionNodeSchema = z
  .object({
    type: z.literal('system_action').describe('Node type: system command execution'),
    runtime: z.enum(['bash', 'node']).describe('Runtime environment for the command'),
    command: z
      .string()
      .min(1, 'Command must not be empty')
      .describe('Command to execute (supports {{handlebars}} interpolation)'),
    timeout_seconds: z
      .number()
      .int()
      .min(1, 'timeout_seconds must be at least 1')
      .max(300, 'timeout_seconds must be at most 300')
      .default(30)
      .optional()
      .describe('Timeout in seconds (default 30)'),
    transitions: z
      .array(TransitionSchema)
      .min(1, 'system_action node must have at least one transition')
      .describe('Transitions evaluated after the command completes'),
    env: z.record(z.string(), z.string()).optional().describe('Additional environment variables'),
    working_dir: z.string().optional().describe('Working directory for command execution'),
  })
  .strict()
  .describe('A system action node that runs a shell or Node.js command');

export const TerminalNodeSchema = z
  .object({
    type: z.literal('terminal').describe('Node type: terminal (end) state'),
    status: z.enum(['success', 'failure', 'cancelled']).describe('Terminal status of the workflow'),
    message: z.string().optional().describe('Template-able summary message'),
  })
  .strict()
  .describe('A terminal node — the workflow ends here');

// ---------------------------------------------------------------------------
// Combined node definition (discriminated union)
// ---------------------------------------------------------------------------

export const NodeDefinitionSchema = z
  .discriminatedUnion('type', [LlmDecisionNodeSchema, LlmTaskNodeSchema, SystemActionNodeSchema, TerminalNodeSchema])
  .describe('A workflow node — one of llm_decision, llm_task, system_action, or terminal');

// ---------------------------------------------------------------------------
// Top-level workflow schema (structural only — no cross-field checks)
// ---------------------------------------------------------------------------

/** Regex for workflow names: kebab-case, 3-64 chars, starts with a letter. */
const WORKFLOW_NAME_REGEX = /^[a-z][a-z0-9-]*$/;

const WorkflowStructuralSchema = z
  .object({
    version: z.literal('1.0').describe('Schema version — currently only "1.0" is supported'),
    workflow_name: z
      .string()
      .min(3, 'workflow_name must be at least 3 characters')
      .max(64, 'workflow_name must be at most 64 characters')
      .regex(
        WORKFLOW_NAME_REGEX,
        'workflow_name must be kebab-case (lowercase letters, digits, hyphens) starting with a letter',
      )
      .describe('Unique kebab-case identifier for this workflow'),
    description: z
      .string()
      .min(1, 'Description must not be empty')
      .max(500, 'Description must be at most 500 characters')
      .describe('Human-readable summary of the workflow purpose'),
    initial_node: z.string().min(1, 'initial_node must not be empty').describe('The node key where execution begins'),
    nodes: z
      .record(z.string(), NodeDefinitionSchema)
      .refine((obj) => Object.keys(obj).length > 0, {
        message: 'Workflow must have at least one node',
      })
      .describe('Map of node identifiers to their definitions'),
    metadata: z.record(z.string(), z.unknown()).optional().describe('Optional arbitrary key-value metadata'),
  })
  .strict()
  .describe('DAWE Workflow Definition v1.0');

// ---------------------------------------------------------------------------
// Cross-field validation
// ---------------------------------------------------------------------------

/**
 * Full workflow schema with cross-field validations applied via
 * `.superRefine()` so that **all** errors are collected in a single pass.
 */
export const WorkflowDefinitionSchema = WorkflowStructuralSchema.superRefine((workflow, ctx) => {
  const nodeKeys = new Set(Object.keys(workflow.nodes));

  // 1. initial_node must exist in nodes
  if (!nodeKeys.has(workflow.initial_node)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['initial_node'],
      message: `initial_node "${workflow.initial_node}" does not reference an existing node`,
      params: { errorCode: SchemaErrorCode.INVALID_NODE_REFERENCE },
    });
  }

  // 2. Check for at least one terminal node
  const terminalNodeKeys: string[] = [];
  for (const [key, node] of Object.entries(workflow.nodes)) {
    if (node.type === 'terminal') {
      terminalNodeKeys.push(key);
    }
  }
  if (terminalNodeKeys.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['nodes'],
      message: 'Workflow must contain at least one terminal node',
      params: { errorCode: SchemaErrorCode.MISSING_TERMINAL_NODE },
    });
  }

  // 3. initial_node must not be a terminal node
  const initialNodeDef = workflow.nodes[workflow.initial_node];
  if (initialNodeDef?.type === 'terminal') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['initial_node'],
      message: `initial_node "${workflow.initial_node}" must not be a terminal node`,
      params: { errorCode: SchemaErrorCode.INITIAL_NODE_IS_TERMINAL },
    });
  }

  // 4. Per-node checks
  for (const [key, node] of Object.entries(workflow.nodes)) {
    if (node.type === 'terminal') {
      // Terminal nodes must not have transitions (enforced by schema strict,
      // but we add an explicit check for clarity)
      // Note: The TerminalNode schema doesn't allow a `transitions` field,
      // so this is already structurally enforced. No runtime check needed.
    } else {
      // Non-terminal nodes — validate transition targets
      const transitions = node.transitions;
      if (transitions.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['nodes', key, 'transitions'],
          message: `Non-terminal node "${key}" must have at least one transition`,
          params: { errorCode: SchemaErrorCode.NON_TERMINAL_NO_TRANSITIONS },
        });
      }

      for (let i = 0; i < transitions.length; i++) {
        const t = transitions[i];
        if (t && !nodeKeys.has(t.target)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['nodes', key, 'transitions', i, 'target'],
            message: `Transition target "${t.target}" in node "${key}" does not reference an existing node`,
            params: { errorCode: SchemaErrorCode.INVALID_NODE_REFERENCE },
          });
        }
      }
    }
  }
});

// ---------------------------------------------------------------------------
// Inferred TypeScript types
// ---------------------------------------------------------------------------

export type WorkflowDefinition = z.infer<typeof WorkflowDefinitionSchema>;
export type NodeDefinition = z.infer<typeof NodeDefinitionSchema>;
export type Transition = z.infer<typeof TransitionSchema>;
export type LlmDecisionNode = z.infer<typeof LlmDecisionNodeSchema>;
export type LlmTaskNode = z.infer<typeof LlmTaskNodeSchema>;
export type SystemActionNode = z.infer<typeof SystemActionNodeSchema>;
export type TerminalNode = z.infer<typeof TerminalNodeSchema>;
