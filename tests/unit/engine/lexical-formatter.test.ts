/**
 * Unit tests for LexicalFormatter — Smart Lexical Formatter utility.
 *
 * Covers all acceptance criteria from issue #76 (DAWE-002):
 * - Gerund conversion (snake_case, kebab-case, single word)
 * - Irregular verb dictionary
 * - English gerund rules (silent-e, consonant doubling, -ie → -ying)
 * - Edge cases (empty string, single char, mixed delimiters, numerics)
 * - Public API shape
 */

import { describe, it, expect } from 'vitest';
import { LexicalFormatter, IRREGULAR_VERBS } from '../../../src/engine/utils/LexicalFormatter.js';

// ---------------------------------------------------------------------------
// P0 — Gerund Conversion
// ---------------------------------------------------------------------------

describe('LexicalFormatter.toActionPhrase', () => {
  describe('snake_case conversion', () => {
    it('converts snake_case node IDs', () => {
      expect(LexicalFormatter.toActionPhrase('gather_requirements')).toBe('Gathering requirements');
    });

    it('converts multi-word snake_case', () => {
      expect(LexicalFormatter.toActionPhrase('draft_pull_request')).toBe('Drafting pull request');
    });
  });

  describe('kebab-case conversion', () => {
    it('converts kebab-case node IDs', () => {
      expect(LexicalFormatter.toActionPhrase('run-security-scan')).toBe('Running security scan');
    });

    it('converts multi-word kebab-case', () => {
      expect(LexicalFormatter.toActionPhrase('check-pr-status')).toBe('Checking pr status');
    });
  });

  describe('single-word inputs', () => {
    it('converts a single word', () => {
      expect(LexicalFormatter.toActionPhrase('build')).toBe('Building');
    });

    it('converts "push"', () => {
      expect(LexicalFormatter.toActionPhrase('push')).toBe('Pushing');
    });

    it('converts "deploy"', () => {
      expect(LexicalFormatter.toActionPhrase('deploy')).toBe('Deploying');
    });
  });

  // ---------------------------------------------------------------------------
  // P0 — Irregular Verb Dictionary
  // ---------------------------------------------------------------------------

  describe('irregular verbs', () => {
    it('maps "bash" to "Executing command"', () => {
      expect(LexicalFormatter.toActionPhrase('bash')).toBe('Executing command');
    });

    it('maps "gh" to "Accessing GitHub"', () => {
      expect(LexicalFormatter.toActionPhrase('gh')).toBe('Accessing GitHub');
    });

    it('performs case-insensitive lookup on first word', () => {
      expect(LexicalFormatter.toActionPhrase('BASH')).toBe('Executing command');
      expect(LexicalFormatter.toActionPhrase('Bash')).toBe('Executing command');
      expect(LexicalFormatter.toActionPhrase('GH')).toBe('Accessing GitHub');
    });

    it('appends remaining words after irregular verb match', () => {
      expect(LexicalFormatter.toActionPhrase('bash_script_runner')).toBe('Executing command script runner');
    });
  });

  describe('IRREGULAR_VERBS dictionary', () => {
    it('is exported and extensible', () => {
      expect(IRREGULAR_VERBS).toBeDefined();
      expect(typeof IRREGULAR_VERBS).toBe('object');

      // Should be extensible (not frozen)
      expect(Object.isFrozen(IRREGULAR_VERBS)).toBe(false);
    });

    it('is also accessible via LexicalFormatter.IRREGULAR_VERBS', () => {
      expect(LexicalFormatter.IRREGULAR_VERBS).toBe(IRREGULAR_VERBS);
    });

    it('can be extended at runtime', () => {
      IRREGULAR_VERBS['kubectl'] = 'Managing Kubernetes';
      expect(LexicalFormatter.toActionPhrase('kubectl')).toBe('Managing Kubernetes');
      // Clean up
      delete IRREGULAR_VERBS['kubectl'];
    });
  });

  // ---------------------------------------------------------------------------
  // P0 — Edge Case Handling
  // ---------------------------------------------------------------------------

  describe('edge cases', () => {
    it('returns empty string for empty input', () => {
      expect(LexicalFormatter.toActionPhrase('')).toBe('');
    });

    it('handles single character input', () => {
      const result = LexicalFormatter.toActionPhrase('a');
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
    });

    it('handles mixed delimiters', () => {
      expect(LexicalFormatter.toActionPhrase('run-security_scan')).toBe('Running security scan');
    });

    it('trims leading delimiters', () => {
      expect(LexicalFormatter.toActionPhrase('_run_tests')).toBe('Running tests');
      expect(LexicalFormatter.toActionPhrase('-run-tests')).toBe('Running tests');
    });

    it('trims trailing delimiters', () => {
      expect(LexicalFormatter.toActionPhrase('run_tests_')).toBe('Running tests');
      expect(LexicalFormatter.toActionPhrase('run-tests-')).toBe('Running tests');
    });

    it('handles consecutive delimiters', () => {
      expect(LexicalFormatter.toActionPhrase('run__tests')).toBe('Running tests');
      expect(LexicalFormatter.toActionPhrase('run--tests')).toBe('Running tests');
    });

    it('preserves numeric segments', () => {
      expect(LexicalFormatter.toActionPhrase('step_2_validate')).toBe('Stepping 2 validate');
    });

    it('handles only delimiters', () => {
      expect(LexicalFormatter.toActionPhrase('___')).toBe('');
      expect(LexicalFormatter.toActionPhrase('---')).toBe('');
    });
  });

  // ---------------------------------------------------------------------------
  // P1 — English Gerund Rules
  // ---------------------------------------------------------------------------

  describe('English gerund rules', () => {
    it('drops silent-e: "analyze" → "Analyzing"', () => {
      expect(LexicalFormatter.toActionPhrase('analyze_data')).toBe('Analyzing data');
    });

    it('drops silent-e: "create" → "Creating"', () => {
      expect(LexicalFormatter.toActionPhrase('create')).toBe('Creating');
    });

    it('drops silent-e: "make" → "Making"', () => {
      expect(LexicalFormatter.toActionPhrase('make')).toBe('Making');
    });

    it('drops silent-e: "write" → "Writing"', () => {
      expect(LexicalFormatter.toActionPhrase('write_file')).toBe('Writing file');
    });

    it('doubles consonant: "run" → "Running"', () => {
      expect(LexicalFormatter.toActionPhrase('run_tests')).toBe('Running tests');
    });

    it('doubles consonant: "scan" → "Scanning"', () => {
      expect(LexicalFormatter.toActionPhrase('scan_files')).toBe('Scanning files');
    });

    it('doubles consonant: "stop" → "Stopping"', () => {
      expect(LexicalFormatter.toActionPhrase('stop')).toBe('Stopping');
    });

    it('doubles consonant: "step" → "Stepping"', () => {
      expect(LexicalFormatter.toActionPhrase('step')).toBe('Stepping');
    });

    it('-ie → -ying: "die" → "Dying"', () => {
      expect(LexicalFormatter.toActionPhrase('die')).toBe('Dying');
    });

    it('-ie → -ying: "lie" → "Lying"', () => {
      expect(LexicalFormatter.toActionPhrase('lie')).toBe('Lying');
    });

    it('-ie → -ying: "tie" → "Tying"', () => {
      expect(LexicalFormatter.toActionPhrase('tie')).toBe('Tying');
    });

    it('does not drop -ee: "see" → "Seeing"', () => {
      expect(LexicalFormatter.toActionPhrase('see')).toBe('Seeing');
    });

    it('handles "read" correctly (silent-e drop)', () => {
      // "read" ends with 'd', not 'e', so standard rule → "reading"
      expect(LexicalFormatter.toActionPhrase('read')).toBe('Reading');
    });

    it('handles already-gerund input', () => {
      expect(LexicalFormatter.toActionPhrase('running_tests')).toBe('Running tests');
    });

    it('default: just add -ing for words not matching special rules', () => {
      expect(LexicalFormatter.toActionPhrase('build')).toBe('Building');
      expect(LexicalFormatter.toActionPhrase('install_packages')).toBe('Installing packages');
    });
  });

  // ---------------------------------------------------------------------------
  // P0 — Public API Shape
  // ---------------------------------------------------------------------------

  describe('public API', () => {
    it('LexicalFormatter.toActionPhrase is a static method', () => {
      expect(typeof LexicalFormatter.toActionPhrase).toBe('function');
    });

    it('LexicalFormatter.IRREGULAR_VERBS is the exported dictionary', () => {
      expect(LexicalFormatter.IRREGULAR_VERBS).toBe(IRREGULAR_VERBS);
      expect(LexicalFormatter.IRREGULAR_VERBS['bash']).toBe('Executing command');
    });
  });
});
