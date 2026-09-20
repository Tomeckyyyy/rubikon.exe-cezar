import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { AgentBrowser, bootProjectId, cezarCli, fixtureServeEnv } from './agent-browser'

/**
 * The cross-machine handoff flow, in a real browser, against a real cezar (spec
 * `.ai/specs/2026-09-19-cross-machine-task-handoff.md`, § UI/UX / Phase 3 step 10):
 *
 *   finished task → "Hand off…" → bundle on the machine's shelf + handed-off badge
 *   → Tasks → "Import a bundle" → the same preview `--dry-run` prints → Import
 *   → the task is imported here (fresh session from its journal on Continue).
 *
 * A throwaway repo with a fixture `runs.json`, like `quick-list.e2e.ts` — the run store is read
 * once at boot, so a fixture is the honest way to hold a finished task still without depending on
 * mock-agent timing. `fixtureServeEnv` pins `CEZ_HOME`, which is also what keeps the bundle shelf
 * inside the fixture (`<dataRoot>/.cez-home/cache/handoff`) rather than a real user's cache.
 */

const runId = `e2e-handoff-${process.pid}`

const now = Date.now()
const ago = (ms: number) => new Date(now - ms).toISOString()

/** A terminal task, exactly as `runs.json` holds it (`RunRecord`). No branch: the bundle then
 *  carries the record, its transcript and its journal, and the plan says "no worktree" — which is
 *  the honest state of a task that ran in place. */
const TASK_ID = 'handoff-fixture-task'
const FIXTURE = [
  {
    id: TASK_ID,
    title: 'Move the parser fix to the VPS',
    titleSummary: 'Move the parser fix to the VPS',
    workflow: 'quick-task',
    task: 'fix the parser, then hand it off',
    status: 'done',
    createdAt: ago(50 * 60_000),
    finishedAt: ago(20 * 60_000),
    tokensUsed: 4_200,
    archived: false,
    steps: [
      {
        id: 'work',
        name: 'Work',
        kind: 'agent',
        status: 'done',
        iterations: 1,
        tokensUsed: 4_200,
        sessionId: 'sess-laptop-1',
        backend: 'claude',
      },
    ],
  },
]

function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const probe = createServer()
    probe.once('error', fail)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = typeof address === 'object' && address ? address.port : 0
      probe.close(() => done(port))
    })
  })
}

async function waitForHealth(url: string): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      if ((await fetch(`${url}/api/v1/health`)).ok) return
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(`cezar e2e: the fixture server never answered at ${url}`)
}

/** A JSON GET that survives a RESET idle connection (the `quick-list` note, same reason). */
async function getJson<T>(url: string): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return (await fetch(url).then((r) => r.json())) as T
    } catch (err) {
      if (attempt >= 1) throw err
    }
  }
}

let browser: AgentBrowser
let server: ChildProcess
let dataRoot: string
let baseUrl: string
let bootProject: string

const BUNDLE_SHELF = () => join(dataRoot, '.cez-home/cache/handoff')
const scoped = (path: string) => `/p/${bootProject}${path}`

beforeAll(async () => {
  dataRoot = mkdtempSync(join(tmpdir(), 'cezar-e2e-handoff-'))
  mkdirSync(join(dataRoot, '.ai/cezar/runs'), { recursive: true })
  writeFileSync(join(dataRoot, '.ai/cezar/runs.json'), JSON.stringify(FIXTURE, null, 2), 'utf8')
  writeFileSync(
    join(dataRoot, '.ai/cezar/runs', `${TASK_ID}.ndjson`),
    `${JSON.stringify({ seq: 1, ts: ago(45 * 60_000), type: 'user-message', text: 'fix the parser' })}\n` +
      `${JSON.stringify({ seq: 2, ts: ago(44 * 60_000), type: 'text', text: 'parser fixed' })}\n`,
    'utf8',
  )
  writeFileSync(
    join(dataRoot, '.ai/cezar/runs', `${TASK_ID}.handoff.md`),
    `# Handoff — Move the parser fix to the VPS\n\n**Task id:** ${TASK_ID}\n\n## Goal\n\nfix the parser\n\n## Progress log\n\n- ${ago(44 * 60_000)} — parser fixed, tests green\n\n## Resume notes\n\n- open the draft PR\n`,
    'utf8',
  )

  const port = await freePort()
  baseUrl = `http://localhost:${port}`
  server = spawn(
    process.execPath,
    [cezarCli, 'serve', '--repo', dataRoot, '--port', String(port), '--no-open'],
    { env: fixtureServeEnv(dataRoot), stdio: 'ignore' },
  )
  await waitForHealth(baseUrl)
  bootProject = await bootProjectId(baseUrl)

  browser = AgentBrowser.open(runId)
  browser.setViewport(1440, 900)
}, 90_000)

afterAll(() => {
  browser?.close()
  server?.kill()
  if (dataRoot) rmSync(dataRoot, { recursive: true, force: true })
})

describe('cross-machine handoff', () => {
  it('hands a finished task off from its page, then imports it back through the dialog', async () => {
    // ---- hand off ----------------------------------------------------------
    browser.goto(`${baseUrl}${scoped(`/tasks/${TASK_ID}`)}`)
    browser.waitForFunction(`document.querySelector('[data-slot="run-header"]') !== null`)
    browser.waitForFunction(`document.querySelector('[data-slot="handoff-run"]') !== null`)
    browser.click('[data-slot="handoff-run"]')

    // The mark lands on the record (the badge and the button's disabled state ride the same
    // refetch) and the bundle lands on the machine's shelf.
    browser.waitForFunction(
      `document.querySelector('[data-slot="handoff-badge"][data-direction="out"]') !== null`,
    )
    const handedOff = await getJson<{ handoff?: { direction: string } }>(
      `${baseUrl}/api/v1/runs/${TASK_ID}`,
    )
    expect(handedOff.handoff?.direction).toBe('out')
    const shelf = readdirSync(BUNDLE_SHELF()).filter((name) => name.endsWith('.tgz'))
    expect(shelf).toHaveLength(1)
    expect(existsSync(join(BUNDLE_SHELF(), shelf[0]!))).toBe(true)

    // The badge says what it means: the tooltip carries the consequence, not just the state.
    expect(browser.evaluate(
      `document.querySelector('[data-slot="handoff-badge"]').getAttribute('aria-label')`,
    )).toContain('Continue refuses until it is unmarked')

    // The API lists the same shelf the dialog will render.
    const listed = await getJson<{ bundles: Array<{ name: string }> }>(
      `${baseUrl}/api/v1/handoff/bundles`,
    )
    expect(listed.bundles.map((bundle) => bundle.name)).toEqual(shelf)

    // ---- import it back through the cockpit --------------------------------
    browser.goto(`${baseUrl}${scoped('/')}`)
    browser.waitForFunction(`document.querySelector('[data-slot="import-handoff"]') !== null`)
    browser.click('[data-slot="import-handoff"]')
    browser.waitForFunction(`document.querySelector('[data-slot="handoff-import-dialog"]') !== null`)
    browser.waitForFunction(`document.querySelector('[data-slot="handoff-bundle"]') !== null`)

    // Select the bundle: the preview is the CLI's `--dry-run`, as markup.
    browser.click('[data-slot="handoff-bundle"]')
    browser.waitForFunction(`document.querySelector('[data-slot="handoff-plan"]') !== null`)
    const plan = browser.evaluate(
      `document.querySelector('[data-slot="handoff-plan"]').textContent`,
    ) as string
    expect(plan).toContain('Move the parser fix to the VPS')
    // The task already exists here, so the plan says `replace` — the upsert a re-import performs.
    expect(plan).toContain('replace')
    expect(plan).toContain('no worktree')

    browser.click('[data-slot="handoff-import-confirm"]')
    browser.waitForFunction(`document.querySelector('[data-slot="handoff-import-dialog"]') === null`)

    const imported = await getJson<{ handoff?: { direction: string }; steps: Array<{ sessionId?: string }> }>(
      `${baseUrl}/api/v1/runs/${TASK_ID}`,
    )
    expect(imported.handoff?.direction).toBe('in')
    // The dead source session did not travel: Continue on the destination is a fresh, journal-
    // seeded session rather than a resume of something this machine never had.
    expect(imported.steps[0]?.sessionId).toBeUndefined()

    // ---- and the badge now says "imported" ---------------------------------
    browser.goto(`${baseUrl}${scoped(`/tasks/${TASK_ID}`)}`)
    browser.waitForFunction(
      `document.querySelector('[data-slot="handoff-badge"][data-direction="in"]') !== null`,
    )
  })
})
