import type { Pool, QueryResult, QueryResultRow } from "pg";

import { waitForAbortable } from "./abort.js";

export async function abortablePoolQuery<R extends QueryResultRow>(
  pool: Pool,
  text: string,
  values: readonly unknown[],
  signal?: AbortSignal,
): Promise<QueryResult<R>> {
  if (!signal) return pool.query<R>(text, [...values]);
  signal.throwIfAborted();

  const pendingClient = pool.connect();
  let client;
  try {
    client = await waitForAbortable(pendingClient, signal);
  } catch (error) {
    void pendingClient.then((lateClient) => lateClient.release()).catch(() => {});
    throw error;
  }

  let released = false;
  const release = (destroy: boolean | Error = false) => {
    if (released) return;
    released = true;
    client.release(destroy);
  };
  const onAbort = () => release(true);
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    signal.throwIfAborted();
    const result = await waitForAbortable(client.query<R>(text, [...values]), signal);
    signal.throwIfAborted();
    return result;
  } catch (error) {
    if (signal.aborted) signal.throwIfAborted();
    release(error instanceof Error ? error : true);
    throw error;
  } finally {
    signal.removeEventListener("abort", onAbort);
    release();
  }
}
