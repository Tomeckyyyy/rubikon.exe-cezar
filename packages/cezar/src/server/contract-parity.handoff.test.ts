import type { InferRequestType, InferResponseType } from 'hono/client';
import { hc } from 'hono/client';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import type {
  handoffBundlesResponseSchema,
  handoffExportRequestSchema,
  handoffExportResponseSchema,
  handoffImportPlanSchema,
  handoffImportRequestSchema,
  handoffImportResponseSchema,
  handoffUnmarkRequestSchema,
  handoffUnmarkResponseSchema,
} from '@open-mercato/cezar-contract';
import type { AppType } from './app-type.ts';

/**
 * `packages/contract/src/handoff.ts` must describe EXACTLY what the handoff routes send and
 * accept — no wider, no narrower. Same guard as `contract-parity.dispatch.test.ts`: each schema is
 * checked against the ROUTE's own inferred type, in BOTH directions, because one-way
 * assignability is green on real drift. Compile-time; `npm run typecheck` enforces it.
 *
 * The record half (`RunRecord.handoff`) rides the existing run routes and is covered by
 * `contract-parity.runs.test.ts`.
 */
describe('src/contract/handoff.ts matches the handoff routes exactly', () => {
  const client = hc<AppType>('http://127.0.0.1');

  type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : 'route-is-wider') : 'schema-is-wider';
  type Exact<Schema, Route> = Mutual<Schema, Route>;
  type Assert<T extends true> = T;

  type Bundles = InferResponseType<typeof client.api.v1.handoff.bundles.$get, 200>;
  type Preview = InferResponseType<typeof client.api.v1.handoff.bundles.preview.$get, 200>;
  type Export200 = InferResponseType<typeof client.api.v1.handoff.export.$post, 200>;
  type Import200 = InferResponseType<typeof client.api.v1.handoff.import.$post, 200>;
  type Unmark200 = InferResponseType<typeof client.api.v1.handoff.unmark.$post, 200>;
  type ExportBody = InferRequestType<typeof client.api.v1.handoff.export.$post>['json'];
  type ImportBody = InferRequestType<typeof client.api.v1.handoff.import.$post>['json'];
  type UnmarkBody = InferRequestType<typeof client.api.v1.handoff.unmark.$post>['json'];

  type _Checks = [
    Assert<Exact<z.infer<typeof handoffBundlesResponseSchema>, Bundles>>,
    // The preview IS the plan the import applies — one schema for both answers.
    Assert<Exact<z.infer<typeof handoffImportPlanSchema>, Preview>>,
    Assert<Exact<z.infer<typeof handoffExportResponseSchema>, Export200>>,
    Assert<Exact<z.infer<typeof handoffImportResponseSchema>, Import200>>,
    Assert<Exact<z.infer<typeof handoffUnmarkResponseSchema>, Unmark200>>,
    // The request halves. `z.input`, not `z.infer`: what a CALLER may send is the input side.
    Assert<Exact<z.input<typeof handoffExportRequestSchema>, ExportBody>>,
    Assert<Exact<z.input<typeof handoffImportRequestSchema>, ImportBody>>,
    Assert<Exact<z.input<typeof handoffUnmarkRequestSchema>, UnmarkBody>>,
  ];

  it('is enforced by tsc, not at runtime', () => {
    type Wrong = Mutual<{ id: string }, { id: number }>;
    const wrong: Wrong = 'schema-is-wider';
    expect(wrong).toBe('schema-is-wider');
  });
});