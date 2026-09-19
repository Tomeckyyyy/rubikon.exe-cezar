import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentRunSpec } from '../core/agent-runner.ts';
import { seedHandoffFile } from '../handoff.ts';
import { RunStore } from '../runs/store.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { RunManager } from './run.ts';

/** Every spec a (mocked) runner's `startSession` receives, in spawn order. */
const captured = vi.hoisted(() => ({ specs: [] as AgentRunSpec[] }));

vi.mock('../core/runner-factory.ts', () => ({
  createRunner: () => ({
    backend: 'claude' as const,
    run: async () => ({ text: '', toolCalls: [], tokensUsed: 0 }),
    startSession: (spec: AgentRunSpec) => {
      captured.specs.push(spec);
      return {
        result: Promise.resolve({ text: 'ok', toolCalls: [], tokensUsed: 0 }),
        sendMessage: () => false,
        end: () => {},
        interrupt: () => {},
        open: false,
      };
    },
    interrupt: async () => {},
  }),
}));

/**
 * The machine boundary on the CONTINUATION path (spec
 * `.ai/specs/2026-09-19-cross-machine-task-handoff.md`):
 *
 *  - a run marked `direction: 'out'` refuses Continue (its work belongs to the other machine) and
 *    names the undo;
 *  - a run marked `direction: 'in'` with no session id (import clears them) CONTINUES on a fresh
 *    session seeded by its handoff journal, never claiming to resume a conversation it did not;
 *  - every other sessionless run keeps the historical refusal;
 *  - `recover()` retires — never re-arms — a usage-limit resume on a handed-off run.
 */
describe('Continue across machines', () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager | undefined;

  beforeEach(() => {
    captured.specs.length = 0;
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-handoff-continue-'));
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = new RunManager(store, repoRoot, { semaphore: new WorkspaceSemaphore({ initial: { maxParallel: 0 } }) });
  });

  afterEach(() => {
    manager?.dispose();
    manager = undefined;
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  function terminalRun(opts: {
    handoff?: { direction: 'out' | 'in'; at: string; peer?: string };
    agentProfile?: string;
    status?: 'done' | 'failed';
    error?: string;
    autoResumeAt?: string;
  } = {}): string {
    const record = store.createRun({
      title: 't',
      workflow: 'quick-task',
      task: 'do the thing',
      steps: [{ id: 'work', name: 'Work', kind: 'agent' }],
      ...(opts.agentProfile ? { agentProfile: opts.agentProfile } : {}),
    });
    store.updateRun(record.id, {
      status: opts.status ?? 'done',
      finishedAt: '2026-09-19T11:00:00.000Z',
      error: opts.error,
      autoResumeAt: opts.autoResumeAt,
      ...(opts.handoff ? { handoff: opts.handoff } : {}),
    });
    store.updateStep(record.id, 'work', { status: 'done' });
    return record.id;
  }

  async function specAt(index: number): Promise<AgentRunSpec> {
    await expect.poll(() => captured.specs.length, { timeout: 15_000 }).toBeGreaterThan(index);
    return captured.specs[index] as AgentRunSpec;
  }

  it('refuses Continue on a handed-off (out) run and names the unmark command', () => {
    const id = terminalRun({ handoff: { direction: 'out', at: '2026-09-19T11:00:00.000Z' } });
    const result = manager!.continueRun(id, { text: 'keep going' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('handed off to another machine');
    expect(result.error).toContain(`cez handoff unmark ${id.slice(0, 8)}`);
    expect(captured.specs).toHaveLength(0);
    expect(store.getRun(id)?.status).toBe('done'); // untouched
  });

  it('continues an imported (in) run on a fresh session seeded by its journal', async () => {
    const id = terminalRun({ handoff: { direction: 'in', at: '2026-09-19T11:00:00.000Z', peer: 'laptop' } });
    seedHandoffFile(join(repoRoot, '.ai/cezar'), {
      id,
      title: 't',
      workflow: 'quick-task',
      task: 'do the thing',
    });
    store.appendEvent(id, { type: 'user-message', text: 'do the thing' });
    store.appendEvent(id, { type: 'text', text: 'halfway there' });

    expect(manager!.continueRun(id, { text: 'keep going' })).toEqual({ ok: true });
    const spec = await specAt(0);
    // No native resume was attempted, and the journal is attached + named first.
    expect(spec.resume).toBe(false);
    expect(spec.sessionId).toBeUndefined();
    expect(spec.env?.CEZ_HANDOFF_FILE).toBe(join(repoRoot, '.ai/cezar', 'runs', `${id}.handoff.md`));
    expect(spec.userPrompt).toContain('Read your handoff file (CEZ_HANDOFF_FILE) first');
    expect(spec.userPrompt).toContain('handed off from another machine');
    expect(spec.userPrompt).toContain('## Original task\ndo the thing');
    expect(spec.userPrompt).toContain('## New user instruction\nkeep going');
    // The run really ran a session.
    await expect.poll(() => store.getRun(id)?.steps.some((step) => step.id.startsWith('continue-')), { timeout: 15_000 }).toBe(true);
  });

  it('keeps the historical refusal for a sessionless run with neither flag', () => {
    const id = terminalRun();
    const result = manager!.continueRun(id, { text: 'keep going' });
    expect(result).toEqual({ ok: false, error: 'no agent session to resume' });
    expect(captured.specs).toHaveLength(0);
  });

  it('refuses an imported run whose agent account does not exist here, unless the caller picks one', () => {
    const id = terminalRun({
      handoff: { direction: 'in', at: '2026-09-19T11:00:00.000Z' },
      agentProfile: 'work-laptop',
    });
    const refused = manager!.continueRun(id, { text: 'keep going' });
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain('agent account "work-laptop"');
    expect(refused.error).toContain('Settings → Agent accounts');
    expect(captured.specs).toHaveLength(0);

    // An explicit account choice (the composer's pill) is the documented way through.
    expect(manager!.continueRun(id, { text: 'keep going', agentProfile: 'default' })).toEqual({ ok: true });
  });

  it('recover() retires a pending usage-limit resume on a handed-off run instead of firing it', async () => {
    const id = terminalRun({
      handoff: { direction: 'out', at: '2026-09-19T11:00:00.000Z' },
      status: 'failed',
      error: 'Claude AI usage limit reached|1756166400',
      autoResumeAt: new Date(Date.now() - 60_000).toISOString(),
    });
    store.updateStep(id, 'work', { sessionId: 'sess-src', backend: 'claude' });
    manager!.dispose();
    manager = new RunManager(store, repoRoot, { semaphore: new WorkspaceSemaphore({ initial: { maxParallel: 0 } }) });

    await manager.recover();
    expect(captured.specs).toHaveLength(0);
    expect(store.getRun(id)?.autoResumeAt).toBeUndefined();
    expect(store.getRun(id)?.status).toBe('failed');
  });
});