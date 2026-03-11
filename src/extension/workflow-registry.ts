/**
 * WorkflowRegistry — Scans directories for YAML workflow definitions,
 * validates them, and caches them for the advance_workflow tool.
 *
 * Default scan paths: ./workflows/, ~/.pi/workflows/
 * Invalid YAML files are logged as warnings but don't crash the registry.
 */

import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

import type { WorkflowDefinition } from '../schemas/workflow.schema.js';
import { validateWorkflowFull } from '../engine/composite-validation.js';
import { DAWELogger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Package root resolution (import.meta.url-based, works in all environments)
// ---------------------------------------------------------------------------

/** Absolute path to the package root, resolved from this module's location. */
export const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Absolute path to the bundled example workflows directory. */
export const BUNDLED_EXAMPLES_DIR = join(PACKAGE_ROOT, 'workflows', 'examples');

/** Absolute path to the bundled scripts directory. */
export const BUNDLED_SCRIPTS_DIR = join(PACKAGE_ROOT, 'workflows', 'scripts');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Summary info for listing workflows. */
export interface WorkflowSummary {
  name: string;
  description: string;
}

/** A cached, validated workflow definition. */
interface CachedWorkflow {
  definition: WorkflowDefinition;
  sourcePath: string;
}

// ---------------------------------------------------------------------------
// WorkflowRegistry
// ---------------------------------------------------------------------------

export class WorkflowRegistry {
  private readonly workflowDirs: string[];
  private readonly cache = new Map<string, CachedWorkflow>();
  private readonly warnings: string[] = [];
  private readonly logger: DAWELogger;

  constructor(workflowDirs?: string[], options?: { logger?: DAWELogger }) {
    this.workflowDirs = workflowDirs ?? [
      BUNDLED_EXAMPLES_DIR, // Bundled examples (resolved from package root via import.meta.url)
      join(homedir(), '.pi', 'workflows'), // User-authored workflows
      resolve('./workflows'), // Project-local workflows (CWD — development convenience)
    ];
    this.logger = options?.logger ?? new DAWELogger({ level: 'warn' });
  }

  /**
   * Scan all configured directories for .yml/.yaml files, validate, and cache.
   */
  async loadAll(): Promise<void> {
    this.cache.clear();
    this.warnings.length = 0;

    this.logger.info('Loading all workflows', { directories: this.workflowDirs });

    for (const dir of this.workflowDirs) {
      await this.scanDirectory(dir);
    }

    this.logger.info('Workflow loading complete', {
      workflowCount: this.cache.size,
      warningCount: this.warnings.length,
    });
  }

  /**
   * Get a workflow by name.
   */
  get(name: string): WorkflowDefinition | undefined {
    return this.cache.get(name)?.definition;
  }

  /**
   * List all available workflows.
   */
  list(): WorkflowSummary[] {
    return Array.from(this.cache.entries()).map(([name, cached]) => ({
      name,
      description: cached.definition.description,
    }));
  }

  /**
   * Reload a specific workflow from its source path.
   */
  async reload(name: string): Promise<void> {
    const cached = this.cache.get(name);
    if (!cached) {
      return;
    }

    this.logger.info('Reloading workflow', { name, sourcePath: cached.sourcePath });

    try {
      const content = await readFile(cached.sourcePath, 'utf-8');
      const result = validateWorkflowFull(content);
      if (result.ok) {
        this.cache.set(name, {
          definition: result.data.definition,
          sourcePath: cached.sourcePath,
        });
        this.logger.info('Workflow reloaded successfully', { name });
      } else {
        this.warnings.push(`Failed to reload workflow "${name}" from ${cached.sourcePath}: validation failed`);
        this.logger.warn('Workflow reload failed: validation error', { name, sourcePath: cached.sourcePath });
      }
    } catch {
      this.warnings.push(`Failed to reload workflow "${name}" from ${cached.sourcePath}: file read error`);
      this.logger.warn('Workflow reload failed: file read error', { name, sourcePath: cached.sourcePath });
    }
  }

  /**
   * Get any warnings collected during loading.
   */
  getWarnings(): string[] {
    return [...this.warnings];
  }

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  private async scanDirectory(dir: string): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      // Directory doesn't exist or can't be read — not an error
      this.warnings.push(`Directory not found or unreadable: ${dir}`);
      this.logger.warn('Workflow directory not found or unreadable', { directory: dir });
      return;
    }

    const yamlFiles = entries.filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));

    for (const file of yamlFiles) {
      const filePath = join(dir, file);
      try {
        const content = await readFile(filePath, 'utf-8');
        const result = validateWorkflowFull(content);

        if (result.ok) {
          const name = result.data.definition.workflow_name;
          if (this.cache.has(name)) {
            this.warnings.push(`Duplicate workflow name "${name}" — overwriting with definition from ${filePath}`);
          }
          this.cache.set(name, {
            definition: result.data.definition,
            sourcePath: filePath,
          });
          this.logger.info('Workflow loaded', { name, sourcePath: filePath });
        } else {
          this.warnings.push(`Validation failed for ${filePath}: ${JSON.stringify(result.errors)}`);
          this.logger.warn('Workflow validation failed', { filePath });
        }
      } catch {
        this.warnings.push(`Failed to read ${filePath}`);
        this.logger.warn('Failed to read workflow file', { filePath });
      }
    }
  }
}
