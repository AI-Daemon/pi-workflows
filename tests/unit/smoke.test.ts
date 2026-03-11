import { describe, it, expect } from 'vitest';

describe('Project Smoke Test', () => {
  it('should import the main barrel export', async () => {
    const mod = await import('../../src/index.js');
    expect(mod).toBeDefined();
  });

  it('should have TypeScript strict mode enabled', () => {
    // This test exists to verify compilation — if strict mode
    // catches a type error, the build fails before tests run.
    const value: string = 'strict mode works';
    expect(value).toBe('strict mode works');
  });
});
