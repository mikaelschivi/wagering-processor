import { Clock, IdGenerator } from "../../src/application/ports";

export class FixedClock extends Clock {
  readonly sleeps: number[] = [];

  constructor(private current = new Date("2026-02-03T04:05:06.000Z")) {
    super();
  }

  now(): Date {
    return this.current;
  }

  async sleep(ms: number): Promise<void> {
    this.sleeps.push(ms);
    this.current = new Date(this.current.getTime() + ms);
  }
}

export class SequentialIds extends IdGenerator {
  private n = 0;

  next(): string {
    return `id-${++this.n}`;
  }
}
