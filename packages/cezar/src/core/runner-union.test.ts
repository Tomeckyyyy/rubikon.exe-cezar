import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { RUNNER_IDS, perRunner, runnerSchema, type Runner } from '@open-mercato/cezar-contract';
import type { UiBackend as ClientBackend } from '@open-mercato/cezar-api-client';
import { RUNNER_IDS as CORE_RUNNER_IDS } from './agent-runner.ts';
import { PROVIDER_IDS } from './provider-auth.ts';
import type { UiBackend } from './ui-events.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const ALLOWLIST = [
  { path: 'packages/cezar/src/core/ui-events.ts', symbol: 'UiBackend', reason: 'Import-free protocol mirror; exact equality to Runner is checked below.' },
  { path: 'packages/api-client/src/protocol/ui-events.ts', symbol: 'UiBackend', reason: 'Browser-safe import-free protocol mirror; exact equality to Runner is checked below.' },
  { path: 'packages/contract/src/workspace.ts', symbol: 'modelDiscoveryRunnerSchema', reason: 'Intentional subset: only runners with live model discovery.' },
  { path: 'packages/cezar/src/agent-config/catalog.ts', symbol: 'project.agents', reason: 'Intentional shared-memory subset: only runners that consume AGENTS.md.' },
  { path: 'packages/web/src/routes/new-task-form.ts', symbol: 'NATIVE_MODEL_ID_PREFIX', reason: 'Intentional model-prefix subset: only runners with native provider model ids.' },
  { path: 'packages/web/e2e/settings-agents.e2e.ts', symbol: 'RUNNER_IDS', reason: 'Intentional browser fixture order/subset for the providers exercised by this scenario.' },
];

function repeatedRunnerLiterals(source: string): { index: number; text: string }[] {
  const literal = String.raw`['"](?:${RUNNER_IDS.join('|')})['"]`;
  // Arrays, type unions, and repeated equality branches. Single-runner capability checks are valid.
  const patterns = [
    /\[[^\[\]]*\]/g,
    new RegExp(`${literal}(?:\\s*\\|\\s*${literal})+`, 'g'),
    new RegExp(`(?:[\\w.]+\\s*===?\\s*${literal}\\s*\\|\\|\\s*)+[\\w.]+\\s*===?\\s*${literal}`, 'g'),
    new RegExp(`(?:[\\w.]+\\s*===?\\s*${literal}\\s*\\?[^;\\n]+?:\\s*)+[\\w.]+\\s*===?\\s*${literal}`, 'g'),
  ];
  return patterns.flatMap((pattern) => [...source.matchAll(pattern)]
    .filter((match) => new Set(match[0].match(new RegExp(literal, 'g'))).size >= 2)
    .map((match) => ({ index: match.index, text: match[0] })));
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === '__fixtures__') return [];
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(path) && !/\.test\.(ts|tsx)$/.test(path) ? [path] : [];
  });
}

describe('canonical runner contract', () => {
  it('shares the tuple with core and provider auth and keeps both protocol mirrors exact', () => {
    type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
    const serverExact: Exact<Runner, UiBackend> = true;
    const clientExact: Exact<Runner, ClientBackend> = true;
    expect(serverExact && clientExact).toBe(true);
    expect(CORE_RUNNER_IDS).toBe(RUNNER_IDS);
    expect(PROVIDER_IDS).toBe(RUNNER_IDS);
    expect(runnerSchema.options).toEqual(RUNNER_IDS);
  });

  it('keeps optional keys absent and round-trips every runner with caller-selected unknown-key policy', () => {
    const schema = perRunner(z.string().optional());
    const all = Object.fromEntries(RUNNER_IDS.map((runner) => [runner, `${runner}-model`]));
    expect(schema.parse({})).toEqual({});
    expect(schema.parse(all)).toEqual(all);
    expect(schema.passthrough().parse({ future: 'model' })).toEqual({ future: 'model' });
    expect(schema.strict().safeParse({ future: 'model' }).success).toBe(false);
  });

  it('detects hand-written arrays, unions and comparison/ternary chains', () => {
    for (const sample of [
      "const ids = ['claude',\n 'codex'];",
      "type Id = 'claude' | 'codex';",
      "return runner === 'claude' || runner === 'codex';",
      "return runner === 'claude' ? 'Claude' : runner === 'codex' ? 'Codex' : 'Other';",
    ]) expect(repeatedRunnerLiterals(sample).length, sample).toBeGreaterThan(0);
    expect(repeatedRunnerLiterals("runner === 'gemini'")).toEqual([]);
  });

  it('requires a rationale for every exception, rejecting a blank rationale', () => {
    const valid = (entries: typeof ALLOWLIST) => entries.every((entry) => entry.reason.trim().length > 0);
    expect(valid(ALLOWLIST)).toBe(true);
    expect(valid([{ path: 'example.ts', symbol: 'Example', reason: '' }])).toBe(false);
  });

  it('derives production and browser-test runner enumerations from RUNNER_IDS', () => {
    const dirs = ['packages/cezar/src', 'packages/contract/src', 'packages/api-client/src', 'packages/web/src', 'packages/web/e2e'];
    const violations: string[] = [];
    for (const file of dirs.flatMap((dir) => sourceFiles(join(ROOT, dir)))) {
      const path = relative(ROOT, file);
      if (path === 'packages/contract/src/runners.ts') continue; // The canonical declaration itself.
      const source = readFileSync(file, 'utf8');
      for (const match of repeatedRunnerLiterals(source)) {
        const line = source.slice(0, match.index).split('\n').length;
        const lineStart = source.lastIndexOf('\n', match.index) + 1;
        const declaration = source.slice(lineStart, match.index);
        if (ALLOWLIST.some((entry) => entry.path === path && (declaration.includes(entry.symbol) || path === entry.path))) continue;
        violations.push(`${path}:${line}: derive from RUNNER_IDS: ${match.text}`);
      }
    }
    expect(violations).toEqual([]);
  });
});
