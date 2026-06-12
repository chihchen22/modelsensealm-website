/**
 * Run a job in a Web Worker, await the response, and terminate the worker.
 *
 * Pattern: ephemeral workers (one per call). For our scale this is fine —
 * worker startup is ~50-200ms; HW simulations take 1-2s, BGM 5-10s. The
 * overhead is amortised by the work itself.
 *
 * If perf becomes an issue we can swap this for a persistent-worker pool
 * without changing the AppContext call sites.
 */

export interface WorkerSuccess<R> {
  type: "success";
  result: R;
}

export interface WorkerError {
  type: "error";
  message: string;
}

export type WorkerOutcome<R> = WorkerSuccess<R> | WorkerError;

export async function runInWorker<Req, Res>(
  workerFactory: () => Worker,
  request: Req,
  isErrorResponse: (r: unknown) => r is { type: "error"; message: string },
): Promise<Res> {
  return new Promise<Res>((resolve, reject) => {
    const worker = workerFactory();
    let settled = false;

    const cleanup = () => {
      worker.onmessage = null;
      worker.onerror = null;
      worker.terminate();
    };

    worker.onmessage = (e: MessageEvent<unknown>) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (isErrorResponse(e.data)) {
        reject(new Error(e.data.message));
      } else {
        resolve(e.data as Res);
      }
    };

    worker.onerror = (e: ErrorEvent) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(`Worker error: ${e.message || "unknown"}`));
    };

    worker.postMessage(request);
  });
}
