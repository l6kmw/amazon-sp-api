export type RateLimitRejection = "concurrency" | "rate";

export type RateLimitResult =
  | { accepted: true; release: () => void }
  | { accepted: false; reason: RateLimitRejection; retryAfterSeconds: number };

interface LimitState {
  active: number;
  count: number;
  windowStartedAt: number;
}

const WINDOW_MS = 60_000;

export class PrincipalRequestLimiter {
  readonly #requestsPerMinute: number;
  readonly #maxConcurrent: number;
  readonly #now: () => number;
  readonly #states = new Map<string, LimitState>();
  #nextCleanupAt: number;

  constructor(options: {
    requestsPerMinute: number;
    maxConcurrent: number;
    now?: () => number;
  }) {
    this.#requestsPerMinute = options.requestsPerMinute;
    this.#maxConcurrent = options.maxConcurrent;
    this.#now = options.now ?? Date.now;
    this.#nextCleanupAt = this.#now() + WINDOW_MS;
  }

  get trackedPrincipalCount(): number {
    return this.#states.size;
  }

  acquire(principal: string): RateLimitResult {
    const now = this.#now();
    this.#cleanupExpiredStates(now);
    const state = this.#states.get(principal) ?? {
      active: 0,
      count: 0,
      windowStartedAt: now,
    };
    if (now - state.windowStartedAt >= WINDOW_MS) {
      state.count = 0;
      state.windowStartedAt = now;
    }
    this.#states.set(principal, state);

    if (state.active >= this.#maxConcurrent) {
      return { accepted: false, reason: "concurrency", retryAfterSeconds: 1 };
    }
    if (state.count >= this.#requestsPerMinute) {
      return {
        accepted: false,
        reason: "rate",
        retryAfterSeconds: Math.max(1, Math.ceil((WINDOW_MS - (now - state.windowStartedAt)) / 1000)),
      };
    }

    state.active += 1;
    state.count += 1;
    let released = false;
    return {
      accepted: true,
      release: () => {
        if (released) return;
        released = true;
        state.active = Math.max(0, state.active - 1);
      },
    };
  }

  #cleanupExpiredStates(now: number): void {
    if (now < this.#nextCleanupAt) return;
    this.#nextCleanupAt = now + WINDOW_MS;
    for (const [principal, state] of this.#states) {
      if (state.active === 0 && now - state.windowStartedAt >= WINDOW_MS) {
        this.#states.delete(principal);
      }
    }
  }
}
