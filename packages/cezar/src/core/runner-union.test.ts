import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const RUNNER_LITERALS = ['claude', 'codex', 'opencode', 'pi'] as const;
const ALLOWLIST = new Set([
  'packages/cezar/src/core/ui-events.ts',
  'packages/api-client/src/protocol/ui-events.ts',
]);

function sourceFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__fixtures__' || entry.name === 'node_modules') continue;
      files.push(...sourceFiles(path));
    } else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.includes('.test.')) {
      files.push(path);
    }
  }
  return files;
}

function runnerLiterals(line: string): string[] {
  return [...line.matchAll(/["'](claude|codex|opencode|pi)["']/g)].map((match) => match[1]!);
}

describe('runner union guard', () => {
  it('does not duplicate a multi-runner literal outside the two protocol mirrors', () => {
    const repoRoot = join(import.meta.dirname, '../../../..');
    const roots = [
      join(repoRoot, 'packages/cezar/src'),
      join(repoRoot, 'packages/api-client/src'),
      join(repoRoot, 'packages/web/src'),
      join(repoRoot, 'packages/web/e2e'),
    ];
    const violations: string[] = [];
    for (const root of roots) {
      for (const file of sourceFiles(root)) {
        const relativePath = relative(repoRoot, file);
        if (ALLOWLIST.has(relativePath)) continue;
        const lines = readFileSync(file, 'utf8').split('\n');
        lines.forEach((line, index) => {
          const distinct = new Set(runnerLiterals(line));
          if (distinct.size < 2) return;
          if (/\[|\||===|!==|\|\|/.test(line)) {
            violations.push(`${relativePath}:${index + 1} — derive from RUNNER_IDS`);
          }
        });
      }
    }
    expect(violations).toEqual([]);
  });
});
