/**
 * WorkflowRegistry — Scans directories for YAML workflow definitions,
 * validates them, and caches them for the advance_workflow tool.
 *
 * Default scan paths: ./workflows/, ~/.pi/workflows/
 * Invalid YAML files are logged as warnings but don't crash the registry.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';

import type { WorkflowDefinition } from '../schemas/workflow.schema.js';
import { validateWorkflowFull } from '../engine/composite-validation.js';

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

  constructor(workflowDirs?: string[]) {
    this.workflowDirs = workflowDirs ?? [resolve('./workflows'), join(homedir(), '.pi', 'workflows')];
  }

  /**
   * Scan all configured directories for .yml/.yaml files, validate, and cache.
   */
  async loadAll(): Promise<void> {
    this.cache.clear();
    this.warnings.length = 0;

    for (const dir of this.workflowDirs) {
      await this.scanDirectory(dir);
    }
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

    try {
      const content = await readFile(cached.sourcePath, 'utf-8');
      const result = validateWorkflowFull(content);
      if (result.ok) {
        this.cache.set(name, {
          definition: result.data.definition,
          sourcePath: cached.sourcePath,
        });
      } else {
        this.warnings.push(`Failed to reload workflow "${name}" from ${cached.sourcePath}: validation failed`);
      }
    } catch {
      this.warnings.push(`Failed to reload workflow "${name}" from ${cached.sourcePath}: file read error`);
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
        } else {
          this.warnings.push(`Validation failed for ${filePath}: ${JSON.stringify(result.errors)}`);
        }
      } catch {
        this.warnings.push(`Failed to read ${filePath}`);
      }
    }
  }
}
