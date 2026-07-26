import assert from "node:assert/strict";
import test from "node:test";
import { parseInput } from "../src/index.js";

test("parses finite numeric input", () => {
  assert.equal(parseInput("12.5"), 12.5);
  assert.equal(parseInput("-3"), -3);
});

test("rejects missing or non-finite input", () => {
  assert.throws(() => parseInput(undefined), /Input must be a finite number/);
  assert.throws(() => parseInput("not-a-number"), /Input must be a finite number/);
  assert.throws(() => parseInput("Infinity"), /Input must be a finite number/);
});
