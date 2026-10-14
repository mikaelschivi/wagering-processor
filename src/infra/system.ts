import { Clock, IdGenerator } from "../application/ports";

export class SystemClock extends Clock {
  now(): Date {
    return new Date();
  }
}

export class UuidV7Generator extends IdGenerator {
  next(): string {
    return Bun.randomUUIDv7();
  }
}
