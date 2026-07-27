import assert from "node:assert/strict";
import test from "node:test";
import { MainHelper } from "../src/cli.js";

test("parses finite numeric input", () => {
  assert.equal(MainHelper.parseInput("12.5"), 12.5);
  assert.equal(MainHelper.parseInput("-3"), -3);
});

test("rejects missing or non-finite input", () => {
  assert.throws(() => MainHelper.parseInput(undefined), /Input must be a finite number/);
  assert.throws(() => MainHelper.parseInput("not-a-number"), /Input must be a finite number/);
  assert.throws(() => MainHelper.parseInput("Infinity"), /Input must be a finite number/);
});
