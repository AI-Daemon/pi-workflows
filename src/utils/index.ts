/**
 * Utils barrel export.
 */

export type { Result } from './result.js';

// Unified error hierarchy
export {
  DAWEError,
  SchemaValidationError,
  GraphValidationError,
  ExpressionEvaluationError,
  PayloadError,
  SystemActionError,
  RuntimeError,
  SecurityViolationError,
  CycleSafetyError,
} from './errors.js';
export type { ErrorCategory, ErrorSeverity, SerializedError } from './errors.js';

// Error code registry
export { ERROR_CODES, getErrorCodeEntry } from './error-codes.js';
export type { ErrorCodeEntry, ErrorCode } from './error-codes.js';

// Error collector
export { ErrorCollector } from './error-collector.js';

// Logger
export { DAWELogger, getDefaultLogger, setDefaultLogger } from './logger.js';
export type { LogLevel, LogFormat, LoggerOptions } from './logger.js';
