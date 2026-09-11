import assert from "node:assert/strict";
import test from "node:test";
import { transformText } from "../src/formatting.ts";

test("wraps inline formatting without losing surrounding text", () => {
  assert.equal(transformText("hello world", 6, 11, "bold").value, "hello **world**");
  assert.equal(transformText("hello", 0, 5, "underline").value, "<u>hello</u>");
  assert.equal(transformText("hello", 0, 5, "highlight").value, "==hello==");
});

test("turns multiline selections into portable lists", () => {
  assert.equal(transformText("one\ntwo", 0, 7, "number").value, "1. one\n2. two");
  assert.equal(transformText("one\ntwo", 0, 7, "check").value, "- [ ] one\n- [ ] two");
});

test("clear formatting removes the supported marks", () => {
  const marked = "## **A**\n- [ ] ==B==\n<u>C</u>";
  assert.equal(transformText(marked, 0, marked.length, "clear").value, "A\nB\nC");
});

test("non-applicable empty-line actions are no-ops", () => {
  assert.deepEqual(transformText("", 0, 0, "clear"), { value: "", cursor: 0 });
  assert.deepEqual(transformText("", 0, 0, "outdent"), { value: "", cursor: 0 });
});
