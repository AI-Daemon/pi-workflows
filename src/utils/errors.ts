/**
 * Unified Error Hierarchy — Base class and category-specific subclasses.
 *
 * `DAWEError` is the root error type. Every error thrown or collected by
 * the engine is (or wraps) a DAWEError. Each subclass automatically sets
 * its `category` and may include category-specific context fields.
 *
 * Every error carries:
 *   - `code`       Machine-readable code from the error-codes registry.
 *   - `category`   Broad classification (schema, graph, runtime, …).
 *   - `severity`   fatal | error | warning | info.
 *   - `context`    Arbitrary structured metadata.
 *   - `recoverable`  Whether the agent can retry/self-correct.
 *   - `agentHint`  LLM-facing recovery instructions (when recoverable).
 *
 * Serialization:
 *   - `toJSON()`         → machine-readable plain object.
 *   - `toAgentMessage()` → formatted English text for the Pi agent.
 */

import { getErrorCodeEntry } from './error-codes.js';

// ---------------------------------------------------------------------------
// Enumerations
// ---------------------------------------------------------------------------

export type ErrorCategory =
  | 'schema'
  | 'graph'
  | 'expression'
  | 'payload'
  | 'execution'
  | 'runtime'
  | 'extension'
  | 'security'
  | 'system'
  | 'cycle';

export type ErrorSeverity = 'fatal' | 'error' | 'warning' | 'info';

// ---------------------------------------------------------------------------
// Serialization shape
// ---------------------------------------------------------------------------

/** JSON-safe representation of a DAWEError. */
export interface SerializedError {
  code: string;
  message: string;
  category: ErrorCategory;
  severity: ErrorSeverity;
  recoverable: boolean;
  agentHint?: string;
  context: Record<string, unknown>;
  stack?: string;
}

// ---------------------------------------------------------------------------
// DAWEError base class
// ---------------------------------------------------------------------------

export class DAWEError extends Error {
  readonly code: string;
  readonly category: ErrorCategory;
  readonly severity: ErrorSeverity;
  readonly context: Record<string, unknown>;
  readonly recoverable: boolean;
  readonly agentHint?: string;

  constructor(
    code: string,
    message: string,
    options?: {
      category?: ErrorCategory;
      severity?: ErrorSeverity;
      recoverable?: boolean;
      agentHint?: string;
      context?: Record<string, unknown>;
      cause?: Error;
    },
  ) {
    super(message, options?.cause ? { cause: options.cause } : undefined);
    this.name = 'DAWEError';
    this.code = code;

    // Try to fill from the registry, then allow explicit overrides
    const entry = getErrorCodeEntry(code);
    this.category = options?.category ?? (entry?.category as ErrorCategory) ?? 'system';
    this.severity = options?.severity ?? entry?.severity ?? 'error';
    this.recoverable = options?.recoverable ?? entry?.recoverable ?? false;
    const hint = options?.agentHint ?? entry?.agentHint;
    if (hint !== undefined) {
      this.agentHint = hint;
    }
    this.context = options?.context ?? {};
  }

  /** Machine-readable JSON serialization. */
  toJSON(): SerializedError {
    return {
      code: this.code,
      message: this.message,
      category: this.category,
      severity: this.severity,
      recoverable: this.recoverable,
      ...(this.agentHint !== undefined ? { agentHint: this.agentHint } : {}),
      context: this.context,
      ...(this.stack ? { stack: this.stack } : {}),
    };
  }

  /** LLM-friendly error message with optional recovery hint. */
  toAgentMessage(): string {
    const lines: string[] = [];
    lines.push(`ERROR (${this.code}): ${this.message}`);

    // Add context details if useful
    const contextKeys = Object.keys(this.context);
    if (contextKeys.length > 0) {
      lines.push('');
      for (const key of contextKeys) {
        const value = this.context[key];
        const formatted =
          typeof value === 'object' && value !== null
            ? JSON.stringify(value)
            : String(value as string | number | boolean);
        lines.push(`${key}: ${formatted}`);
      }
    }

    if (this.agentHint) {
      lines.push('');
      lines.push(`RECOVERY: ${this.agentHint}`);
    }

    return lines.join('\n');
  }
}

// ---------------------------------------------------------------------------
// Category-specific subclasses
// ---------------------------------------------------------------------------

export class SchemaValidationError extends DAWEError {
  constructor(
    code: string,
    message: string,
    options?: {
      severity?: ErrorSeverity;
      recoverable?: boolean;
      agentHint?: string;
      context?: Record<string, unknown>;
      cause?: Error;
    },
  ) {
    super(code, message, { ...options, category: 'schema' });
    this.name = 'SchemaValidationError';
  }
}

export class GraphValidationError extends DAWEError {
  constructor(
    code: string,
    message: string,
    options?: {
      severity?: ErrorSeverity;
      recoverable?: boolean;
      agentHint?: string;
      context?: Record<string, unknown>;
      cause?: Error;
    },
  ) {
    super(code, message, { ...options, category: 'graph' });
    this.name = 'GraphValidationError';
  }
}

export class ExpressionEvaluationError extends DAWEError {
  constructor(
    code: string,
    message: string,
    options?: {
      severity?: ErrorSeverity;
      recoverable?: boolean;
      agentHint?: string;
      context?: Record<string, unknown>;
      cause?: Error;
    },
  ) {
    super(code, message, { ...options, category: 'expression' });
    this.name = 'ExpressionEvaluationError';
  }
}

export class PayloadError extends DAWEError {
  constructor(
    code: string,
    message: string,
    options?: {
      severity?: ErrorSeverity;
      recoverable?: boolean;
      agentHint?: string;
      context?: Record<string, unknown>;
      cause?: Error;
    },
  ) {
    super(code, message, { ...options, category: 'payload' });
    this.name = 'PayloadError';
  }
}

export class SystemActionError extends DAWEError {
  constructor(
    code: string,
    message: string,
    options?: {
      severity?: ErrorSeverity;
      recoverable?: boolean;
      agentHint?: string;
      context?: Record<string, unknown>;
      cause?: Error;
    },
  ) {
    super(code, message, { ...options, category: 'execution' });
    this.name = 'SystemActionError';
  }
}

export class RuntimeError extends DAWEError {
  constructor(
    code: string,
    message: string,
    options?: {
      severity?: ErrorSeverity;
      recoverable?: boolean;
      agentHint?: string;
      context?: Record<string, unknown>;
      cause?: Error;
    },
  ) {
    super(code, message, { ...options, category: 'runtime' });
    this.name = 'RuntimeError';
  }
}

export class SecurityViolationError extends DAWEError {
  constructor(
    code: string,
    message: string,
    options?: {
      severity?: ErrorSeverity;
      recoverable?: boolean;
      agentHint?: string;
      context?: Record<string, unknown>;
      cause?: Error;
    },
  ) {
    super(code, message, { ...options, category: 'security' });
    this.name = 'SecurityViolationError';
  }
}

export class CycleSafetyError extends DAWEError {
  constructor(
    code: string,
    message: string,
    options?: {
      severity?: ErrorSeverity;
      recoverable?: boolean;
      agentHint?: string;
      context?: Record<string, unknown>;
      cause?: Error;
    },
  ) {
    super(code, message, { ...options, category: 'cycle' });
    this.name = 'CycleSafetyError';
  }
}
