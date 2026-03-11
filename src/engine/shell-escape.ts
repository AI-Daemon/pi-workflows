/**
 * Shell escaping utility for safe command interpolation.
 *
 * When injecting user-controlled values into shell commands,
 * all values MUST be shell-escaped to prevent injection attacks.
 */

/**
 * Shell-escape a value by wrapping it in single quotes and escaping
 * any internal single quotes.
 *
 * @example
 * ```ts
 * shellEscape("hello world")     // "'hello world'"
 * shellEscape("it's")            // "'it'\\''s'"
 * shellEscape("$(dangerous)")    // "'$(dangerous)'"
 * shellEscape("; rm -rf /")      // "'; rm -rf /'"
 * ```
 *
 * @param value - The value to escape. Non-string values are coerced via `String()`.
 * @returns The shell-safe escaped string wrapped in single quotes.
 */
export function shellEscape(value: unknown): string {
  const str = String(value);
  // Wrap in single quotes, escape internal single quotes
  // Each internal ' becomes: '\'' (end quote, escaped literal quote, start quote)
  return "'" + str.replace(/'/g, "'\\''") + "'";
}
