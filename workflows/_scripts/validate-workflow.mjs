#!/usr/bin/env node
/**
 * validate-workflow.mjs — Validates a DAWE workflow YAML file.
 *
 * Usage:
 *   node validate-workflow.mjs <yaml-file-path> [json-output-path]
 *
 * Runs full composite validation (schema + expression + graph).
 * Exits 0 on success, 1 on validation errors.
 * Writes JSON report to output path if provided.
 */

import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

// Resolve DAWE package root: env var > two levels up from _scripts/
const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = process.env.DAWE_PACKAGE_ROOT || resolve(__dirname, '..', '..');
const { validateWorkflowFull } = await import(resolve(packageRoot, 'dist', 'engine', 'composite-validation.js'));

const yamlPath = process.argv[2];
const jsonOutputPath = process.argv[3] || '/tmp/dawe/validate-result.json';

if (!yamlPath) {
  console.error('Usage: node validate-workflow.mjs <yaml-file-path> [json-output-path]');
  process.exit(2);
}

let yamlString;
try {
  yamlString = readFileSync(yamlPath, 'utf-8');
} catch (err) {
  const report = { valid: false, errors: [{ message: `Cannot read file: ${yamlPath} — ${err.message}` }] };
  writeFileSync(jsonOutputPath, JSON.stringify(report, null, 2));
  console.error(report.errors[0].message);
  process.exit(1);
}

const result = validateWorkflowFull(yamlString);

if (result.ok) {
  const report = {
    valid: true,
    workflow_name: result.data.definition.workflow_name,
    version: result.data.definition.version,
    node_count: Object.keys(result.data.definition.nodes).length,
    warnings: result.data.warnings || [],
  };
  writeFileSync(jsonOutputPath, JSON.stringify(report, null, 2));
  console.log(`✅ Workflow "${report.workflow_name}" is valid (${report.node_count} nodes, v${report.version})`);
  if (report.warnings.length > 0) {
    console.log(`⚠️  ${report.warnings.length} warning(s):`);
    for (const w of report.warnings) {
      console.log(`   - ${w.message}`);
    }
  }
  process.exit(0);
} else {
  const report = {
    valid: false,
    errors: result.errors.map(e => ({
      path: e.path || '',
      message: e.message,
      code: e.code || '',
    })),
  };
  writeFileSync(jsonOutputPath, JSON.stringify(report, null, 2));
  console.error(`❌ Validation failed with ${report.errors.length} error(s):`);
  for (const e of report.errors) {
    console.error(`   [${e.code}] ${e.path ? e.path + ': ' : ''}${e.message}`);
  }
  process.exit(1);
}
