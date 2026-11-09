/**
 * Byte cap for streamed request bodies (pure; no DB).
 *
 * `req.formData()` buffers the whole multipart body before anything can be
 * checked, so a 2 GB upload would be read in full. Piping the body through
 * `byteCapTransform` aborts the stream — and therefore the parse — as soon as
 * the accumulated bytes exceed the cap, before buffering continues.
 */

export class BodyTooLargeError extends Error {
  constructor(public readonly cap: number) {
    super(`Request body exceeds ${cap} bytes`);
    this.name = "BodyTooLargeError";
  }
}

export function byteCapTransform(cap: number): TransformStream<Uint8Array, Uint8Array> {
  let seen = 0;
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      seen += chunk.byteLength;
      if (seen > cap) {
        controller.error(new BodyTooLargeError(cap));
        return;
      }
      controller.enqueue(chunk);
    },
  });
}

/** A copy of `req` whose body is capped at `cap` bytes; the same headers/method so `formData()` still parses. */
export function cappedRequest(req: Request, cap: number): Request {
  if (!req.body) return req;
  // `duplex` is required by the Fetch spec for streaming bodies; Node's types lag behind it.
  const init: RequestInit & { duplex: "half" } = { method: req.method, headers: req.headers, body: req.body.pipeThrough(byteCapTransform(cap)), duplex: "half" };
  return new Request(req.url, init);
}

export function isBodyTooLarge(err: unknown): boolean {
  return err instanceof BodyTooLargeError || (err instanceof Error && /exceeds \d+ bytes/.test(err.message));
}
