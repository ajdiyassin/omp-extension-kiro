import type { AssistantMessage, AssistantMessageEvent, AssistantMessageEventStream } from "@oh-my-pi/pi-ai";

class EventStream<T, R = T> implements AsyncIterable<T> {
  queue: T[] = [];
  waiting: Array<{ resolve: (value: IteratorResult<T, undefined>) => void; reject: (err: unknown) => void }> = [];
  done = false;
  resultSettled = false;
  #failed = false;
  #error: unknown = undefined;
  finalResultPromise: Promise<R>;
  resolveFinalResult!: (result: R) => void;
  rejectFinalResult!: (err: unknown) => void;
  isComplete: (event: T) => boolean;
  extractResult: (event: T) => R;

  constructor(isComplete: (event: T) => boolean, extractResult: (event: T) => R) {
    let resolveFn!: (value: R) => void;
    let rejectFn!: (err: unknown) => void;
    const promise = new Promise<R>((res, rej) => {
      resolveFn = res;
      rejectFn = rej;
    });
    promise.catch(() => {});
    this.finalResultPromise = promise;
    this.resolveFinalResult = resolveFn;
    this.rejectFinalResult = rejectFn;
    this.isComplete = isComplete;
    this.extractResult = extractResult;
  }

  push(event: T): void {
    if (this.done) return;
    if (this.isComplete(event)) {
      this.done = true;
      this.resultSettled = true;
      this.resolveFinalResult(this.extractResult(event));
    }
    const waiter = this.waiting.shift();
    if (waiter) {
      waiter.resolve({ value: event, done: false });
    } else {
      this.queue.push(event);
    }
  }

  deliver(event: T): void {
    const waiter = this.waiting.shift();
    if (waiter) {
      waiter.resolve({ value: event, done: false });
    } else {
      this.queue.push(event);
    }
  }

  end(result?: R): void {
    this.done = true;
    if (result !== undefined) {
      this.resultSettled = true;
      this.resolveFinalResult(result);
    } else if (!this.resultSettled) {
      this.resultSettled = true;
      this.rejectFinalResult(new Error("Stream ended without a final result"));
    }
    for (const waiter of this.waiting.splice(0)) {
      waiter.resolve({ value: undefined, done: true });
    }
  }

  fail(err: unknown): void {
    if (this.done) return;
    this.done = true;
    this.#failed = true;
    this.#error = err;
    this.resultSettled = true;
    this.rejectFinalResult(err);
    for (const waiter of this.waiting.splice(0)) {
      waiter.reject(err);
    }
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    while (true) {
      const next = this.queue.shift();
      if (next !== undefined) {
        yield next;
      } else if (this.#failed) {
        throw this.#error;
      } else if (this.done) {
        return;
      } else {
        const result = await new Promise<IteratorResult<T, undefined>>((resolve, reject) =>
          this.waiting.push({ resolve, reject }),
        );
        if (result.done) return;
        yield result.value;
      }
    }
  }

  result(): Promise<R> {
    return this.finalResultPromise;
  }
}

export class LocalAssistantMessageEventStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
  constructor() {
    super(
      (event) => event.type === "done" || event.type === "error",
      (event) => {
        if (event.type === "done") return event.message;
        if (event.type === "error") return event.error as unknown as AssistantMessage;
        throw new Error("Unexpected event type for final result");
      },
    );
  }

  override push(event: AssistantMessageEvent): void {
    if (this.done) return;
    if (this.isComplete(event)) {
      this.done = true;
      this.resultSettled = true;
      this.resolveFinalResult(this.extractResult(event));
    }
    this.deliver(event);
  }

  override end(result?: AssistantMessage): void {
    this.done = true;
    if (result !== undefined) {
      this.resultSettled = true;
      this.resolveFinalResult(result);
    } else if (!this.resultSettled) {
      this.resultSettled = true;
      this.rejectFinalResult(new Error("Stream ended without a final result"));
    }
    for (const waiter of this.waiting.splice(0)) {
      waiter.resolve({ value: undefined, done: true });
    }
  }
}

export function createAssistantMessageEventStream(): AssistantMessageEventStream {
  return new LocalAssistantMessageEventStream() as unknown as AssistantMessageEventStream;
}
