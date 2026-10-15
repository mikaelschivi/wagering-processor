import { Clock, IdGenerator } from "../application/ports";

export class SystemClock extends Clock {
  now(): Date {
    return new Date();
  }

  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

export class UuidV7Generator extends IdGenerator {
  next(): string {
    return Bun.randomUUIDv7();
  }
}
