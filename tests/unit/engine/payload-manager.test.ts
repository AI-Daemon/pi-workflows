/**
 * Unit tests for PayloadManager.
 *
 * Covers: construction, merge behavior, immutability, scoping,
 * template resolution, history, serialization, validation (P1),
 * diff utility (P1), and size limits (P1).
 *
 * Target: ≥ 95% line coverage, ≥ 90% branch coverage, 100% function coverage.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { z } from 'zod';
import { PayloadManager } from '../../../src/engine/payload-manager.js';
import { resolveTemplate } from '../../../src/engine/template-engine.js';
import samplePayload from '../../fixtures/payloads/sample-payload.json';
import deepNestedPayload from '../../fixtures/payloads/deep-nested-payload.json';

// ---------------------------------------------------------------------------
// Construction & basic operations
// ---------------------------------------------------------------------------

describe('PayloadManager', () => {
  describe('Construction & basic operations', () => {
    it('empty constructor → empty payload', () => {
      const pm = new PayloadManager();
      expect(pm.getPayload()).toEqual({});
    });

    it('constructor with initial data → payload contains data', () => {
      const initial = { name: 'test', count: 42 };
      const pm = new PayloadManager(initial);
      expect(pm.getPayload()).toEqual({ name: 'test', count: 42 });
    });

    it('getPayload() returns deep clone — mutating return value does not affect internal state', () => {
      const pm = new PayloadManager({ name: 'original' });
      const retrieved = pm.getPayload() as Record<string, unknown>;
      retrieved['name'] = 'mutated';
      retrieved['injected'] = true;
      expect(pm.getPayload()).toEqual({ name: 'original' });
    });

    it('reset() clears all data and history', () => {
      const pm = new PayloadManager({ key: 'value' });
      pm.merge('node1', { extra: 'data' });
      expect(pm.getPayload()).not.toEqual({});
      expect(pm.getHistory().length).toBeGreaterThan(0);

      pm.reset();
      expect(pm.getPayload()).toEqual({});
      expect(pm.getHistory()).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // Merge tests
  // -------------------------------------------------------------------------

  describe('Merge behavior', () => {
    let pm: PayloadManager;

    beforeEach(() => {
      pm = new PayloadManager();
    });

    it('simple merge adds new keys', () => {
      pm.merge('nodeA', { name: 'foo', count: 1 });
      expect(pm.getPayload()).toEqual({ name: 'foo', count: 1 });
    });

    it('merge overwrites existing primitive keys', () => {
      pm.merge('nodeA', { name: 'foo' });
      pm.merge('nodeB', { name: 'bar' });
      expect(pm.getPayload()).toEqual({ name: 'bar' });
    });

    it('deep merge of nested objects preserves existing nested keys', () => {
      pm.merge('nodeA', { user: { name: 'Alice' } });
      pm.merge('nodeB', { user: { role: 'admin' } });
      expect(pm.getPayload()).toEqual({
        user: { name: 'Alice', role: 'admin' },
      });
    });

    it('array replacement (not concatenation)', () => {
      pm.merge('nodeA', { tags: ['a', 'b'] });
      pm.merge('nodeB', { tags: ['c'] });
      expect(pm.getPayload()).toEqual({ tags: ['c'] });
    });

    it('null value sets key to null', () => {
      pm.merge('nodeA', { name: 'foo' });
      pm.merge('nodeB', { name: null });
      const payload = pm.getPayload();
      expect(payload['name']).toBeNull();
    });

    it('undefined value is stripped from merge', () => {
      pm.merge('nodeA', { name: 'foo', keep: 'yes' });
      pm.merge('nodeB', { name: undefined, keep: 'still' });
      expect(pm.getPayload()).toEqual({ name: 'foo', keep: 'still' });
    });

    it('multiple sequential merges accumulate state correctly', () => {
      pm.merge('node1', { a: 1 });
      pm.merge('node2', { b: 2 });
      pm.merge('node3', { c: 3 });
      expect(pm.getPayload()).toEqual({ a: 1, b: 2, c: 3 });
    });

    it('merge records provenance (nodeId tracked per entry)', () => {
      pm.merge('gather-info', { project: 'test' });
      const history = pm.getHistory();
      expect(history).toHaveLength(1);
      expect(history[0]!.nodeId).toBe('gather-info');
    });

    it('merge from different nodes with overlapping keys — last wins', () => {
      pm.merge('nodeA', { status: 'pending' });
      pm.merge('nodeB', { status: 'complete' });
      expect(pm.getPayload()).toEqual({ status: 'complete' });
    });

    it('merge with deeply nested object (3+ levels)', () => {
      pm.merge('nodeA', {
        level1: { level2: { level3: { value: 'deep' } } },
      });
      pm.merge('nodeB', {
        level1: { level2: { level3: { extra: 'added' } } },
      });
      expect(pm.getPayload()).toEqual({
        level1: { level2: { level3: { value: 'deep', extra: 'added' } } },
      });
    });

    it('constructor initial data is cloned — mutation of original does not affect payload', () => {
      const initial = { nested: { value: 'original' } };
      const pm2 = new PayloadManager(initial);
      (initial.nested as Record<string, unknown>).value = 'mutated';
      expect(pm2.getPayload()).toEqual({ nested: { value: 'original' } });
    });
  });

  // -------------------------------------------------------------------------
  // Immutability tests
  // -------------------------------------------------------------------------

  describe('Immutability guarantees', () => {
    it('mutating getPayload() return value → internal state unchanged', () => {
      const pm = new PayloadManager({ user: { name: 'Alice' } });
      const p = pm.getPayload() as Record<string, unknown>;
      (p['user'] as Record<string, unknown>)['name'] = 'Hacker';
      expect((pm.getPayload() as Record<string, unknown>)['user']).toEqual({ name: 'Alice' });
    });

    it('mutating getScoped() return value → internal state unchanged', () => {
      const pm = new PayloadManager({ user: { name: 'Alice', role: 'admin' } });
      const scoped = pm.getScoped(['user']);
      (scoped['user'] as Record<string, unknown>)['name'] = 'Hacker';
      expect((pm.getPayload() as Record<string, unknown>)['user']).toEqual({
        name: 'Alice',
        role: 'admin',
      });
    });

    it('mutating the data object passed to merge() after merge → internal state unchanged', () => {
      const pm = new PayloadManager();
      const data = { info: { secret: 'original' } };
      pm.merge('nodeA', data);
      data.info.secret = 'tampered';
      expect(pm.getPayload()).toEqual({ info: { secret: 'original' } });
    });
  });

  // -------------------------------------------------------------------------
  // Scoping tests
  // -------------------------------------------------------------------------

  describe('Context scoping (getScoped)', () => {
    let pm: PayloadManager;

    beforeEach(() => {
      pm = new PayloadManager({
        name: 'Alice',
        age: 30,
        user: { role: 'admin', email: 'alice@example.com' },
        settings: { theme: 'dark' },
      });
    });

    it('getScoped(["name"]) returns only name key', () => {
      expect(pm.getScoped(['name'])).toEqual({ name: 'Alice' });
    });

    it('getScoped(["user.role"]) returns nested value', () => {
      expect(pm.getScoped(['user.role'])).toEqual({ user: { role: 'admin' } });
    });

    it('getScoped(["nonexistent"]) returns empty object', () => {
      expect(pm.getScoped(['nonexistent'])).toEqual({});
    });

    it('getScoped([]) returns empty object', () => {
      expect(pm.getScoped([])).toEqual({});
    });

    it('getScoped with mix of existing and missing keys → only existing returned', () => {
      expect(pm.getScoped(['name', 'missing', 'user.role'])).toEqual({
        name: 'Alice',
        user: { role: 'admin' },
      });
    });
  });

  // -------------------------------------------------------------------------
  // Template resolution tests
  // -------------------------------------------------------------------------

  describe('Template resolution', () => {
    let pm: PayloadManager;

    beforeEach(() => {
      pm = new PayloadManager({
        name: 'Alice',
        owner: 'ai-daemon',
        repo: 'pi-workflows',
        user: { email: 'alice@example.com' },
        branch: 'develop',
        data: { key: 'value', nested: [1, 2, 3] },
      });
    });

    it('simple variable: "{{payload.name}}" → "Alice"', () => {
      const result = pm.resolveTemplate('{{payload.name}}');
      expect(result).toEqual({ ok: true, data: 'Alice' });
    });

    it('multiple variables: "{{payload.owner}}/{{payload.repo}}" → "ai-daemon/pi-workflows"', () => {
      const result = pm.resolveTemplate('{{payload.owner}}/{{payload.repo}}');
      expect(result).toEqual({ ok: true, data: 'ai-daemon/pi-workflows' });
    });

    it('nested access: "{{payload.user.email}}" → correct value', () => {
      const result = pm.resolveTemplate('{{payload.user.email}}');
      expect(result).toEqual({ ok: true, data: 'alice@example.com' });
    });

    it('missing variable → empty string (not error)', () => {
      const result = pm.resolveTemplate('Hello, {{payload.nonexistent}}!');
      expect(result).toEqual({ ok: true, data: 'Hello, !' });
    });

    it('{{json payload.data}} helper → JSON string', () => {
      const result = pm.resolveTemplate('{{json payload.data}}');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(JSON.parse(result.data)).toEqual({ key: 'value', nested: [1, 2, 3] });
      }
    });

    it('{{default payload.missing "main"}} → uses default when missing', () => {
      const result = pm.resolveTemplate('{{default payload.missing "main"}}');
      expect(result).toEqual({ ok: true, data: 'main' });
    });

    it('{{default payload.branch "main"}} → uses actual value when present', () => {
      const result = pm.resolveTemplate('{{default payload.branch "main"}}');
      expect(result).toEqual({ ok: true, data: 'develop' });
    });

    it('invalid template syntax → TemplateError with INVALID_TEMPLATE code', () => {
      // Use a genuinely malformed template that Handlebars rejects at compile time
      const result = pm.resolveTemplate('{{#if}}');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.code).toBe('INVALID_TEMPLATE');
        expect(result.errors.template).toBe('{{#if}}');
      }
    });

    it('mismatched block tags → TemplateError with INVALID_TEMPLATE code', () => {
      const result = pm.resolveTemplate('{{#each payload.items}}{{/if}}');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.code).toBe('INVALID_TEMPLATE');
      }
    });

    it('missing partial → TemplateError with TEMPLATE_RESOLUTION_FAILED code', () => {
      const result = pm.resolveTemplate('{{> nonexistent}}');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.code).toBe('TEMPLATE_RESOLUTION_FAILED');
      }
    });

    it('template with no variables → returned as-is', () => {
      const result = pm.resolveTemplate('Hello, world!');
      expect(result).toEqual({ ok: true, data: 'Hello, world!' });
    });

    it('noEscape: special characters are NOT HTML-escaped', () => {
      const pm2 = new PayloadManager({ html: '<b>bold</b> & "quotes"' });
      const result = pm2.resolveTemplate('{{payload.html}}');
      expect(result).toEqual({ ok: true, data: '<b>bold</b> & "quotes"' });
    });
  });

  // -------------------------------------------------------------------------
  // History tests
  // -------------------------------------------------------------------------

  describe('Payload history', () => {
    it('no merges → empty history', () => {
      const pm = new PayloadManager();
      expect(pm.getHistory()).toEqual([]);
    });

    it('after merge → history has 1 entry with correct nodeId and keys', () => {
      const pm = new PayloadManager();
      pm.merge('gather', { project: 'test', lang: 'ts' });
      const history = pm.getHistory();
      expect(history).toHaveLength(1);
      expect(history[0]!.nodeId).toBe('gather');
      expect(history[0]!.keysModified).toEqual(expect.arrayContaining(['project', 'lang']));
      expect(history[0]!.timestamp).toBeGreaterThan(0);
    });

    it('after multiple merges → history has entries in order', () => {
      const pm = new PayloadManager();
      pm.merge('node1', { a: 1 });
      pm.merge('node2', { b: 2 });
      pm.merge('node3', { c: 3 });
      const history = pm.getHistory();
      expect(history).toHaveLength(3);
      expect(history[0]!.nodeId).toBe('node1');
      expect(history[1]!.nodeId).toBe('node2');
      expect(history[2]!.nodeId).toBe('node3');
      // Timestamps are non-decreasing
      expect(history[1]!.timestamp).toBeGreaterThanOrEqual(history[0]!.timestamp);
      expect(history[2]!.timestamp).toBeGreaterThanOrEqual(history[1]!.timestamp);
    });

    it('history snapshots are independent (deep cloned at time of merge)', () => {
      const pm = new PayloadManager();
      pm.merge('node1', { counter: 1 });
      pm.merge('node2', { counter: 2 });
      const history = pm.getHistory();
      expect(history[0]!.snapshot).toEqual({ counter: 1 });
      expect(history[1]!.snapshot).toEqual({ counter: 2 });
    });

    it('history is trimmed when maxHistoryEntries is exceeded', () => {
      const pm = new PayloadManager();
      pm.setMaxHistoryEntries(3);
      pm.merge('n1', { a: 1 });
      pm.merge('n2', { b: 2 });
      pm.merge('n3', { c: 3 });
      pm.merge('n4', { d: 4 });
      const history = pm.getHistory();
      expect(history).toHaveLength(3);
      expect(history[0]!.nodeId).toBe('n2');
      expect(history[2]!.nodeId).toBe('n4');
    });

    it('getHistory() returns a deep clone — mutating it does not affect internal history', () => {
      const pm = new PayloadManager();
      pm.merge('node1', { val: 'original' });
      const history = pm.getHistory();
      history[0]!.nodeId = 'tampered';
      history[0]!.snapshot['val'] = 'hacked';
      const fresh = pm.getHistory();
      expect(fresh[0]!.nodeId).toBe('node1');
      expect(fresh[0]!.snapshot).toEqual({ val: 'original' });
    });
  });

  // -------------------------------------------------------------------------
  // Serialization tests
  // -------------------------------------------------------------------------

  describe('Serialization / Deserialization', () => {
    it('serialize() produces valid JSON', () => {
      const pm = new PayloadManager({ key: 'value' });
      pm.merge('node1', { extra: 42 });
      const json = pm.serialize();
      expect(() => JSON.parse(json) as unknown).not.toThrow();
    });

    it('deserialize(serialize()) round-trip preserves payload', () => {
      const pm = new PayloadManager({ name: 'test', count: 99 });
      pm.merge('node1', { extra: 'data' });
      const restored = PayloadManager.deserialize(pm.serialize());
      expect(restored.getPayload()).toEqual(pm.getPayload());
    });

    it('deserialize(serialize()) round-trip preserves history', () => {
      const pm = new PayloadManager();
      pm.merge('n1', { a: 1 });
      pm.merge('n2', { b: 2 });
      const restored = PayloadManager.deserialize(pm.serialize());
      const origHistory = pm.getHistory();
      const restoredHistory = restored.getHistory();
      expect(restoredHistory).toHaveLength(origHistory.length);
      expect(restoredHistory[0]!.nodeId).toBe(origHistory[0]!.nodeId);
      expect(restoredHistory[1]!.snapshot).toEqual(origHistory[1]!.snapshot);
    });

    it('deserialize with invalid JSON → throws meaningful error', () => {
      expect(() => PayloadManager.deserialize('not-json')).toThrow(/invalid JSON/i);
    });

    it('deserialize with non-object → throws meaningful error', () => {
      expect(() => PayloadManager.deserialize('"just a string"')).toThrow(/expected a JSON object/i);
    });

    it('deserialize with wrong version → throws meaningful error', () => {
      expect(() => PayloadManager.deserialize(JSON.stringify({ version: 99, payload: {}, history: [] }))).toThrow(
        /unsupported version/i,
      );
    });

    it('deserialize with missing payload → throws meaningful error', () => {
      expect(() => PayloadManager.deserialize(JSON.stringify({ version: 1, history: [] }))).toThrow(
        /missing or invalid "payload"/i,
      );
    });

    it('deserialize with missing history → throws meaningful error', () => {
      expect(() => PayloadManager.deserialize(JSON.stringify({ version: 1, payload: {} }))).toThrow(
        /missing or invalid "history"/i,
      );
    });

    it('deserialized manager is fully functional (can merge, resolve templates, etc.)', () => {
      const pm = new PayloadManager({ greeting: 'Hello' });
      pm.merge('node1', { target: 'World' });
      const restored = PayloadManager.deserialize(pm.serialize());

      // Can merge
      restored.merge('node2', { extra: 'data' });
      expect(restored.getPayload()).toEqual({ greeting: 'Hello', target: 'World', extra: 'data' });

      // Can resolve templates
      const result = restored.resolveTemplate('{{payload.greeting}}, {{payload.target}}!');
      expect(result).toEqual({ ok: true, data: 'Hello, World!' });

      // Can get scoped
      expect(restored.getScoped(['target'])).toEqual({ target: 'World' });

      // History: 1 from original merge + 1 from new merge = 2
      expect(restored.getHistory().length).toBe(2);
    });
  });

  // -------------------------------------------------------------------------
  // P1 — Payload validation
  // -------------------------------------------------------------------------

  describe('P1: Payload validation (validatePayload)', () => {
    it('valid payload passes validation', () => {
      const pm = new PayloadManager({ name: 'Alice', age: 30 });
      const schema = z.object({ name: z.string(), age: z.number() });
      const result = pm.validatePayload(schema);
      expect(result).toEqual({ ok: true, data: undefined });
    });

    it('invalid payload returns validation errors', () => {
      const pm = new PayloadManager({ name: 42 });
      const schema = z.object({ name: z.string(), required_field: z.string() });
      const result = pm.validatePayload(schema);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.length).toBeGreaterThanOrEqual(1);
        expect(result.errors[0]!.message).toBeDefined();
      }
    });

    it('empty payload fails strict schema validation', () => {
      const pm = new PayloadManager();
      const schema = z.object({ required: z.string() });
      const result = pm.validatePayload(schema);
      expect(result.ok).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // P1 — Diff utility
  // -------------------------------------------------------------------------

  describe('P1: Diff utility (diffFromLastMerge)', () => {
    it('no merges → empty diff', () => {
      const pm = new PayloadManager();
      expect(pm.diffFromLastMerge()).toEqual({});
    });

    it('single merge → diff shows before as undefined', () => {
      const pm = new PayloadManager();
      pm.merge('node1', { name: 'Alice' });
      const diff = pm.diffFromLastMerge();
      expect(diff['name']).toEqual({ before: undefined, after: 'Alice' });
    });

    it('two merges → diff shows before and after for changed keys', () => {
      const pm = new PayloadManager();
      pm.merge('node1', { status: 'pending' });
      pm.merge('node2', { status: 'complete' });
      const diff = pm.diffFromLastMerge();
      expect(diff['status']).toEqual({ before: 'pending', after: 'complete' });
    });

    it('adding a new key shows before as undefined', () => {
      const pm = new PayloadManager();
      pm.merge('node1', { a: 1 });
      pm.merge('node2', { b: 2 });
      const diff = pm.diffFromLastMerge();
      expect(diff['b']).toEqual({ before: undefined, after: 2 });
    });
  });

  // -------------------------------------------------------------------------
  // P1 — Size limit
  // -------------------------------------------------------------------------

  describe('P1: Size limit (isWithinSizeLimit)', () => {
    it('small payload is within default limit', () => {
      const pm = new PayloadManager({ key: 'value' });
      expect(pm.isWithinSizeLimit()).toBe(true);
    });

    it('large payload exceeds a tiny size limit', () => {
      const pm = new PayloadManager();
      pm.setMaxSizeBytes(10); // 10 bytes — absurdly small
      pm.merge('node1', { data: 'a'.repeat(100) });
      expect(pm.isWithinSizeLimit()).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Fixture-based tests
  // -------------------------------------------------------------------------

  describe('Fixture-based tests', () => {
    it('loads and works with sample-payload.json fixture', () => {
      const pm = new PayloadManager(samplePayload as Record<string, unknown>);
      expect(pm.getPayload()).toEqual(samplePayload);

      // Template resolution against fixture data
      const result = pm.resolveTemplate('Project: {{payload.project_name}} by {{payload.user.name}}');
      expect(result).toEqual({ ok: true, data: 'Project: pi-workflows by Alice' });

      // Scoping
      const scoped = pm.getScoped(['project_name', 'user.role']);
      expect(scoped).toEqual({
        project_name: 'pi-workflows',
        user: { role: 'admin' },
      });
    });

    it('loads and works with deep-nested-payload.json fixture', () => {
      const pm = new PayloadManager(deepNestedPayload as Record<string, unknown>);

      // Deep merge on top of fixture data
      pm.merge('node1', {
        level1: { level2: { level3: { level4: { extra: 'new-field' } } } },
      });

      const payload = pm.getPayload() as Record<string, unknown>;
      const level4 = (
        ((payload['level1'] as Record<string, unknown>)['level2'] as Record<string, unknown>)['level3'] as Record<
          string,
          unknown
        >
      )['level4'] as Record<string, unknown>;
      expect(level4).toEqual({
        value: 'deeply-nested',
        count: 42,
        extra: 'new-field',
      });
    });
  });

  // -------------------------------------------------------------------------
  // Edge cases
  // -------------------------------------------------------------------------

  describe('Edge cases', () => {
    it('merge with empty object is a no-op (except history)', () => {
      const pm = new PayloadManager({ key: 'value' });
      pm.merge('noop', {});
      expect(pm.getPayload()).toEqual({ key: 'value' });
      expect(pm.getHistory()).toHaveLength(1);
    });

    it('merge replaces nested object with primitive', () => {
      const pm = new PayloadManager({ user: { name: 'Alice' } });
      pm.merge('node1', { user: 'just-a-string' });
      expect(pm.getPayload()).toEqual({ user: 'just-a-string' });
    });

    it('merge replaces primitive with nested object', () => {
      const pm = new PayloadManager({ user: 'just-a-string' });
      pm.merge('node1', { user: { name: 'Alice' } });
      expect(pm.getPayload()).toEqual({ user: { name: 'Alice' } });
    });

    it('getScoped with deeply nested dot-path', () => {
      const pm = new PayloadManager(deepNestedPayload as Record<string, unknown>);
      const scoped = pm.getScoped(['level1.level2.level3.level4.value']);
      expect(scoped).toEqual({
        level1: { level2: { level3: { level4: { value: 'deeply-nested' } } } },
      });
    });

    it('getScoped with key pointing to null value returns the null', () => {
      const pm = new PayloadManager({ key: null });
      // null is not undefined, so it should be included
      const scoped = pm.getScoped(['key']);
      expect(scoped).toEqual({ key: null });
    });

    it('merge with same node ID multiple times', () => {
      const pm = new PayloadManager();
      pm.merge('nodeA', { step: 1 });
      pm.merge('nodeA', { step: 2 });
      expect(pm.getPayload()).toEqual({ step: 2 });
      expect(pm.getHistory()).toHaveLength(2);
      expect(pm.getHistory()[0]!.nodeId).toBe('nodeA');
      expect(pm.getHistory()[1]!.nodeId).toBe('nodeA');
    });

    it('serialize includes version field', () => {
      const pm = new PayloadManager();
      const parsed = JSON.parse(pm.serialize()) as Record<string, unknown>;
      expect(parsed['version']).toBe(1);
    });

    it('template with complex handlebars: each, if blocks', () => {
      const pm = new PayloadManager({ items: ['a', 'b', 'c'] });
      const result = pm.resolveTemplate('{{#each payload.items}}{{this}},{{/each}}');
      expect(result).toEqual({ ok: true, data: 'a,b,c,' });
    });
  });

  // -------------------------------------------------------------------------
  // Direct template-engine tests (resolveTemplate function)
  // -------------------------------------------------------------------------

  describe('resolveTemplate (standalone function)', () => {
    it('resolves a simple template against a context', () => {
      const result = resolveTemplate('Hello, {{name}}!', { name: 'World' });
      expect(result).toEqual({ ok: true, data: 'Hello, World!' });
    });

    it('json helper works directly', () => {
      const result = resolveTemplate('{{json data}}', { data: { a: 1, b: [2] } });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(JSON.parse(result.data)).toEqual({ a: 1, b: [2] });
      }
    });

    it('default helper works directly', () => {
      const result = resolveTemplate('{{default missing "fallback"}}', {});
      expect(result).toEqual({ ok: true, data: 'fallback' });
    });

    it('parse error at resolution returns INVALID_TEMPLATE', () => {
      const result = resolveTemplate('{{', {});
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.code).toBe('INVALID_TEMPLATE');
      }
    });

    it('non-parse runtime error returns TEMPLATE_RESOLUTION_FAILED', () => {
      const result = resolveTemplate('{{> missing_partial}}', {});
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.code).toBe('TEMPLATE_RESOLUTION_FAILED');
      }
    });
  });
});
