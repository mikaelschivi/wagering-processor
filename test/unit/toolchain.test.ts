import "reflect-metadata";
import { expect, test } from "bun:test";

function Tag(): ClassDecorator {
  return () => {};
}

class Dependency {}

@Tag()
class Consumer {
  constructor(readonly dep: Dependency) {}
}

test("bigint arithmetic is exact", () => {
  expect(10n ** 19n - 1n).toBe(9999999999999999999n);
});

test("decorator metadata is emitted", () => {
  expect(Reflect.getMetadata("design:paramtypes", Consumer)).toEqual([Dependency]);
});
