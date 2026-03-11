/**
 * Type declarations for the jexl (JavaScript Expression Language) module.
 *
 * jexl does not ship its own type definitions, so we provide minimal
 * declarations covering the API surface we use.
 */
declare module 'jexl' {
  class Jexl {
    /** Compile an expression string into a reusable Expression object. */
    compile(expression: string): unknown;

    /** Evaluate an expression string against a context. */
    eval(expression: string, context?: Record<string, unknown>): Promise<unknown>;

    /** Add a unary transform (pipe operator). */
    addTransform(name: string, fn: (value: unknown, ...args: unknown[]) => unknown): void;

    /** Add a binary operator. */
    addBinaryOp(operator: string, precedence: number, fn: (left: unknown, right: unknown) => unknown): void;

    /** Shorthand for eval — bind-safe. */
    expr(expression: string, context?: Record<string, unknown>): Promise<unknown>;
  }

  const jexl: {
    Jexl: typeof Jexl;
    /** Evaluate an expression using the default instance. */
    eval(expression: string, context?: Record<string, unknown>): Promise<unknown>;
    /** Compile an expression using the default instance. */
    compile(expression: string): unknown;
    /** Add a transform to the default instance. */
    addTransform(name: string, fn: (value: unknown, ...args: unknown[]) => unknown): void;
    /** Shorthand for eval on the default instance. */
    expr(expression: string, context?: Record<string, unknown>): Promise<unknown>;
  };

  export default jexl;
  export { Jexl };
}
