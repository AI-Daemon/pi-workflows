/**
 * Unit tests for UxStateManager — Extension UX state caching and tool suppression.
 *
 * Covers all acceptance criteria from DAWE-005:
 * - State caching (update, clear, get)
 * - Tool suppression logic (hide_tools, show_output, self-exclusion)
 * - Spinner concatenation with LexicalFormatter
 * - P2 tool call counting
 *
 * Minimum 12 test cases per spec.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { UxStateManager } from '../../../src/extension/ux-state.js';
import type { ActiveUxState } from '../../../src/extension/ux-state.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeUxState(overrides: Partial<ActiveUxState> = {}): ActiveUxState {
  return {
    base_spinner: 'Gathering requirements',
    hide_tools: true,
    show_output: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('UxStateManager', () => {
  let manager: UxStateManager;

  beforeEach(() => {
    manager = new UxStateManager();
  });

  // =========================================================================
  // State Caching
  // =========================================================================

  describe('state caching', () => {
    // 1. update() caches ux_controls state correctly
    it('should cache ux_controls state on update()', () => {
      const ux = makeUxState();
      manager.update(ux);

      const state = manager.get();
      expect(state).not.toBeNull();
      expect(state!.base_spinner).toBe('Gathering requirements');
      expect(state!.hide_tools).toBe(true);
      expect(state!.show_output).toBe(false);
    });

    // 2. clear() resets state to null
    it('should reset state to null on clear()', () => {
      manager.update(makeUxState());
      expect(manager.get()).not.toBeNull();

      manager.clear();
      expect(manager.get()).toBeNull();
    });

    // 3. get() returns current state
    it('should return current state via get()', () => {
      expect(manager.get()).toBeNull();

      manager.update(makeUxState({ base_spinner: 'Implementing code' }));
      const state = manager.get();
      expect(state).not.toBeNull();
      expect(state!.base_spinner).toBe('Implementing code');
    });

    // 4. State is null when no workflow is active
    it('should return null when no workflow is active', () => {
      expect(manager.get()).toBeNull();
    });

    // 5. State is cleared after workflow completion
    it('should have null state after clear() simulating workflow completion', () => {
      manager.update(makeUxState());
      manager.clear(); // Simulates workflow reaching terminal status
      expect(manager.get()).toBeNull();
    });

    // 6. Multiple sequential update() calls overwrite previous state
    it('should overwrite previous state on sequential update() calls', () => {
      manager.update(makeUxState({ base_spinner: 'First node' }));
      expect(manager.get()!.base_spinner).toBe('First node');

      manager.update(makeUxState({ base_spinner: 'Second node', hide_tools: false }));
      const state = manager.get();
      expect(state!.base_spinner).toBe('Second node');
      expect(state!.hide_tools).toBe(false);
    });

    // 7. update() creates a defensive copy (mutation safety)
    it('should not be affected by external mutation of the input object', () => {
      const ux = makeUxState();
      manager.update(ux);

      // Mutate the original
      ux.base_spinner = 'MUTATED';

      // Internal state should be unaffected
      expect(manager.get()!.base_spinner).toBe('Gathering requirements');
    });

    // 8. get() returns a defensive copy (mutation safety)
    it('should return a copy from get() that does not affect internal state', () => {
      manager.update(makeUxState());
      const state = manager.get()!;
      state.base_spinner = 'MUTATED';

      expect(manager.get()!.base_spinner).toBe('Gathering requirements');
    });
  });

  // =========================================================================
  // shouldSuppressTool()
  // =========================================================================

  describe('shouldSuppressTool()', () => {
    // 9. Returns true when hide_tools=true and tool is not advance_workflow
    it('should return true when hide_tools=true and tool is not advance_workflow', () => {
      manager.update(makeUxState({ hide_tools: true, show_output: false }));

      expect(manager.shouldSuppressTool('read')).toBe(true);
      expect(manager.shouldSuppressTool('bash')).toBe(true);
      expect(manager.shouldSuppressTool('web_search')).toBe(true);
      expect(manager.shouldSuppressTool('edit')).toBe(true);
    });

    // 10. Returns false when hide_tools=false
    it('should return false when hide_tools=false', () => {
      manager.update(makeUxState({ hide_tools: false }));

      expect(manager.shouldSuppressTool('read')).toBe(false);
      expect(manager.shouldSuppressTool('bash')).toBe(false);
    });

    // 11. Returns false for advance_workflow even when hide_tools=true
    it('should return false for advance_workflow even when hide_tools=true', () => {
      manager.update(makeUxState({ hide_tools: true, show_output: false }));

      expect(manager.shouldSuppressTool('advance_workflow')).toBe(false);
    });

    // 12. Returns false when show_output=true (debugging override)
    it('should return false when show_output=true (debugging override)', () => {
      manager.update(makeUxState({ hide_tools: true, show_output: true }));

      expect(manager.shouldSuppressTool('read')).toBe(false);
      expect(manager.shouldSuppressTool('bash')).toBe(false);
    });

    // 13. Returns false when no state is cached (no active workflow)
    it('should return false when no state is cached', () => {
      expect(manager.shouldSuppressTool('read')).toBe(false);
      expect(manager.shouldSuppressTool('bash')).toBe(false);
    });

    // 14. Returns false after clear()
    it('should return false after clear()', () => {
      manager.update(makeUxState({ hide_tools: true, show_output: false }));
      expect(manager.shouldSuppressTool('read')).toBe(true);

      manager.clear();
      expect(manager.shouldSuppressTool('read')).toBe(false);
    });
  });

  // =========================================================================
  // getSpinnerWithTool()
  // =========================================================================

  describe('getSpinnerWithTool()', () => {
    // 15. Returns concatenated string with base_spinner + tool action phrase
    it('should return concatenated string with base_spinner + tool action phrase', () => {
      manager.update(makeUxState({ base_spinner: 'Gathering requirements' }));

      const spinner = manager.getSpinnerWithTool('read_file');
      expect(spinner).toBe('Gathering requirements... Reading file...');
    });

    // 16. Uses LexicalFormatter for tool name formatting
    it('should use LexicalFormatter.toActionPhrase() for tool name formatting', () => {
      manager.update(makeUxState({ base_spinner: 'Implementing code' }));

      // 'bash' is an irregular verb → "Executing command"
      expect(manager.getSpinnerWithTool('bash')).toBe('Implementing code... Executing command...');
    });

    // 17. Handles various tool names correctly
    it('should handle various tool names via LexicalFormatter', () => {
      manager.update(makeUxState({ base_spinner: 'Reviewing' }));

      expect(manager.getSpinnerWithTool('web_search')).toBe('Reviewing... Webbing search...');
      expect(manager.getSpinnerWithTool('edit')).toBe('Reviewing... Editing...');
      expect(manager.getSpinnerWithTool('write')).toBe('Reviewing... Writing...');
    });

    // 18. Returns empty string when no state is cached
    it('should return empty string when no state is cached', () => {
      expect(manager.getSpinnerWithTool('read')).toBe('');
    });

    // 19. Returns base spinner with ... for empty tool names
    it('should return base spinner with ... for empty tool name', () => {
      manager.update(makeUxState({ base_spinner: 'Working' }));
      expect(manager.getSpinnerWithTool('')).toBe('Working...');
    });
  });

  // =========================================================================
  // getBaseSpinner()
  // =========================================================================

  describe('getBaseSpinner()', () => {
    // 20. Returns base spinner with trailing ...
    it('should return base spinner with trailing ...', () => {
      manager.update(makeUxState({ base_spinner: 'Gathering requirements' }));
      expect(manager.getBaseSpinner()).toBe('Gathering requirements...');
    });

    // 21. Returns empty string when no state
    it('should return empty string when no state is cached', () => {
      expect(manager.getBaseSpinner()).toBe('');
    });
  });

  // =========================================================================
  // P2: Suppressed tool call counting
  // =========================================================================

  describe('suppressed tool counting (P2)', () => {
    // 22. recordSuppression increments counter
    it('should increment suppressed count on recordSuppression()', () => {
      manager.update(makeUxState());
      expect(manager.getSuppressedCount()).toBe(0);

      manager.recordSuppression();
      expect(manager.getSuppressedCount()).toBe(1);

      manager.recordSuppression();
      manager.recordSuppression();
      expect(manager.getSuppressedCount()).toBe(3);
    });

    // 23. Counter resets on update()
    it('should reset suppressed count on update()', () => {
      manager.update(makeUxState());
      manager.recordSuppression();
      manager.recordSuppression();
      expect(manager.getSuppressedCount()).toBe(2);

      manager.update(makeUxState({ base_spinner: 'New node' }));
      expect(manager.getSuppressedCount()).toBe(0);
    });

    // 24. Counter resets on clear()
    it('should reset suppressed count on clear()', () => {
      manager.update(makeUxState());
      manager.recordSuppression();
      expect(manager.getSuppressedCount()).toBe(1);

      manager.clear();
      expect(manager.getSuppressedCount()).toBe(0);
    });
  });

  // =========================================================================
  // Integration-like scenarios
  // =========================================================================

  describe('workflow lifecycle scenarios', () => {
    // 25. Full lifecycle: update → suppress → clear
    it('should handle a full workflow lifecycle', () => {
      // No active workflow
      expect(manager.get()).toBeNull();
      expect(manager.shouldSuppressTool('read')).toBe(false);

      // Workflow starts, first node
      manager.update(makeUxState({ base_spinner: 'Gathering requirements', hide_tools: true, show_output: false }));
      expect(manager.shouldSuppressTool('read')).toBe(true);
      expect(manager.shouldSuppressTool('advance_workflow')).toBe(false);
      expect(manager.getSpinnerWithTool('read')).toBe('Gathering requirements... Reading...');

      // Tool completes, spinner reverts
      expect(manager.getBaseSpinner()).toBe('Gathering requirements...');
      manager.recordSuppression();

      // Advance to next node
      manager.update(makeUxState({ base_spinner: 'Implementing code', hide_tools: false, show_output: false }));
      expect(manager.shouldSuppressTool('read')).toBe(false);
      expect(manager.getSuppressedCount()).toBe(0); // Reset on update

      // Workflow completes
      manager.clear();
      expect(manager.get()).toBeNull();
      expect(manager.shouldSuppressTool('read')).toBe(false);
    });

    // 26. Debug mode: show_output overrides hide_tools
    it('should allow debugging via show_output override', () => {
      manager.update(makeUxState({ hide_tools: true, show_output: true }));

      // Even with hide_tools=true, show_output=true means no suppression
      expect(manager.shouldSuppressTool('read')).toBe(false);
      expect(manager.shouldSuppressTool('bash')).toBe(false);

      // Spinner still works though (independent of suppression)
      expect(manager.getSpinnerWithTool('read')).toBe('Gathering requirements... Reading...');
    });
  });
});
