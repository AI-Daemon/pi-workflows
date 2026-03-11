/**
 * Structured Logger — JSON or pretty-printed output.
 *
 * Uses `console.log` / `console.error` as the underlying transport.
 * No external dependency (Winston, Pino, etc.) — keeps it simple.
 * The `DAWELogger` interface allows swapping the transport later
 * without changing call sites.
 *
 * Supports:
 *   - Level filtering (debug, info, warn, error)
 *   - JSON and pretty output formats
 *   - Child loggers with persistent context
 *   - Injectable output function for testing
 *   - Environment variable configuration (DAWE_LOG_LEVEL, DAWE_LOG_FORMAT)
 */

import { DAWEError } from './errors.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Log level hierarchy (lower = more verbose). */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Logger output format. */
export type LogFormat = 'json' | 'pretty';

/** Logger configuration options. */
export interface LoggerOptions {
  /** Minimum log level (default: 'info'). */
  level?: LogLevel;
  /** Output format (default: 'json'). */
  format?: LogFormat;
  /** Persistent context merged into every log entry. */
  context?: Record<string, unknown>;
  /**
   * Injectable output function. Receives the formatted string.
   * Defaults to `console.log` for debug/info/warn and `console.error` for error.
   */
  output?: (line: string) => void;
}

// ---------------------------------------------------------------------------
// Level hierarchy
// ---------------------------------------------------------------------------

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

// ---------------------------------------------------------------------------
// DAWELogger
// ---------------------------------------------------------------------------

export class DAWELogger {
  private readonly level: LogLevel;
  private readonly format: LogFormat;
  private readonly baseContext: Record<string, unknown>;
  private readonly outputFn: (line: string) => void;

  constructor(options?: LoggerOptions) {
    const envLevel = process.env['DAWE_LOG_LEVEL'] as LogLevel | undefined;
    const envFormat = process.env['DAWE_LOG_FORMAT'] as LogFormat | undefined;

    this.level = options?.level ?? envLevel ?? 'info';
    this.format = options?.format ?? envFormat ?? 'json';
    this.baseContext = options?.context ?? {};
    this.outputFn = options?.output ?? ((line: string) => console.log(line));
  }

  debug(message: string, context?: Record<string, unknown>): void {
    this.log('debug', message, undefined, context);
  }

  info(message: string, context?: Record<string, unknown>): void {
    this.log('info', message, undefined, context);
  }

  warn(message: string, context?: Record<string, unknown>): void {
    this.log('warn', message, undefined, context);
  }

  error(message: string, error?: DAWEError | Error, context?: Record<string, unknown>): void {
    this.log('error', message, error, context);
  }

  /**
   * Create a child logger that inherits the parent's config and
   * adds persistent context fields to every entry.
   */
  child(context: Record<string, unknown>): DAWELogger {
    return new DAWELogger({
      level: this.level,
      format: this.format,
      context: { ...this.baseContext, ...context },
      output: this.outputFn,
    });
  }

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  private log(level: LogLevel, message: string, error?: DAWEError | Error, context?: Record<string, unknown>): void {
    if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[this.level]) {
      return;
    }

    const merged = { ...this.baseContext, ...context };

    // Add error fields
    if (error instanceof DAWEError) {
      merged['code'] = error.code;
      merged['category'] = error.category;
      if (Object.keys(error.context).length > 0) {
        Object.assign(merged, error.context);
      }
    } else if (error) {
      merged['errorMessage'] = error.message;
    }

    const output =
      this.format === 'json' ? this.formatJSON(level, message, merged) : this.formatPretty(level, message, merged);

    this.outputFn(output);
  }

  private formatJSON(level: LogLevel, message: string, context: Record<string, unknown>): string {
    const entry: Record<string, unknown> = {
      timestamp: new Date().toISOString(),
      level,
      message,
      ...context,
    };
    return JSON.stringify(entry);
  }

  private formatPretty(level: LogLevel, message: string, context: Record<string, unknown>): string {
    const time = new Date().toISOString().slice(11, 23); // HH:mm:ss.SSS
    const levelStr = level.toUpperCase().padEnd(5);
    const codeVal = context['code'];
    const codeSuffix = typeof codeVal === 'string' ? ` (${codeVal})` : '';
    const lines: string[] = [`[${time}] ${levelStr} ${message}${codeSuffix}`];

    // Append context fields (excluding 'code' which is already shown)
    for (const [key, value] of Object.entries(context)) {
      if (key === 'code') continue;
      const formatted =
        typeof value === 'object' && value !== null
          ? JSON.stringify(value)
          : String(value as string | number | boolean);
      lines.push(`  ${key}: ${formatted}`);
    }

    return lines.join('\n');
  }
}

// ---------------------------------------------------------------------------
// Singleton (optional convenience)
// ---------------------------------------------------------------------------

let _defaultLogger: DAWELogger | undefined;

/** Get or create a default logger instance. */
export function getDefaultLogger(): DAWELogger {
  if (!_defaultLogger) {
    _defaultLogger = new DAWELogger();
  }
  return _defaultLogger;
}

/** Replace the default logger (useful for testing). */
export function setDefaultLogger(logger: DAWELogger): void {
  _defaultLogger = logger;
}
