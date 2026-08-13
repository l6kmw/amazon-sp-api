import assert from "node:assert/strict";
import { test } from "node:test";

import type { Pool, PoolClient, QueryResult } from "pg";

import { abortablePoolQuery } from "../src/postgres-query.js";

const emptyResult = {
  command: "SELECT",
  rowCount: 0,
  oid: 0,
  fields: [],
  rows: [],
} as QueryResult;

test("releases a late PostgreSQL checkout after cancellation", async () => {
  let resolveClient!: (client: PoolClient) => void;
  const pendingClient = new Promise<PoolClient>((resolve) => { resolveClient = resolve; });
  const releases: Array<boolean | Error | undefined> = [];
  let queryCalls = 0;
  const client = {
    query() {
      queryCalls += 1;
      return Promise.resolve(emptyResult);
    },
    release(destroy?: boolean | Error) { releases.push(destroy); },
  } as unknown as PoolClient;
  const pool = { connect: () => pendingClient } as unknown as Pool;
  const controller = new AbortController();
  const reason = new DOMException("request cancelled", "AbortError");

  const query = abortablePoolQuery(pool, "SELECT 1", [], controller.signal);
  controller.abort(reason);
  await assert.rejects(query, (error: unknown) => error === reason);

  resolveClient(client);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(queryCalls, 0);
  assert.deepEqual(releases, [undefined]);
});

test("destroys an active PostgreSQL client when its query is cancelled", async () => {
  let resolveQuery!: (result: QueryResult) => void;
  const pendingQuery = new Promise<QueryResult>((resolve) => { resolveQuery = resolve; });
  const releases: Array<boolean | Error | undefined> = [];
  let queryCalls = 0;
  const client = {
    query() {
      queryCalls += 1;
      return pendingQuery;
    },
    release(destroy?: boolean | Error) { releases.push(destroy); },
  } as unknown as PoolClient;
  const pool = { connect: async () => client } as unknown as Pool;
  const controller = new AbortController();
  const reason = new DOMException("request cancelled", "AbortError");

  const query = abortablePoolQuery(pool, "SELECT 1", [], controller.signal);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(queryCalls, 1);
  controller.abort(reason);

  await assert.rejects(query, (error: unknown) => error === reason);
  assert.deepEqual(releases, [true]);
  resolveQuery(emptyResult);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(releases, [true]);
});

test("releases PostgreSQL clients once on success and destroys them on query failure", async () => {
  for (const failure of [undefined, new Error("query failed")]) {
    const releases: Array<boolean | Error | undefined> = [];
    const client = {
      query: () => failure ? Promise.reject(failure) : Promise.resolve(emptyResult),
      release(destroy?: boolean | Error) { releases.push(destroy); },
    } as unknown as PoolClient;
    const pool = { connect: async () => client } as unknown as Pool;
    const signal = new AbortController().signal;

    if (failure) {
      await assert.rejects(
        abortablePoolQuery(pool, "SELECT 1", [], signal),
        (error: unknown) => error === failure,
      );
      assert.deepEqual(releases, [failure]);
    } else {
      assert.equal(await abortablePoolQuery(pool, "SELECT 1", [], signal), emptyResult);
      assert.deepEqual(releases, [false]);
    }
  }
});
