/**
 * LlmParseError — thrown when an LLM response can't be parsed or fails shape
 * validation (empty body, un-parseable JSON, missing/renamed fields).
 *
 * This is the ONLY error class the research caller loops (runBrainstorm,
 * runValidation, runSimulation) are allowed to retry. Provider / network /
 * rate-limit errors are already retried exhaustively by `withRetry` inside
 * `providerCall` — re-running the whole stage on top of that just multiplies the
 * attempt count (the 30×→60× storm this fix removes). So the caller loops guard
 * on `err instanceof LlmParseError` and re-throw everything else immediately.
 *
 * `instanceof` is safe here: all producers and consumers import this one module,
 * so there is a single class identity in the graph. `.message` is preserved, so
 * `assert.throws(fn, /regex/)` in existing tests keeps matching.
 */
export class LlmParseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LlmParseError';
  }
}
