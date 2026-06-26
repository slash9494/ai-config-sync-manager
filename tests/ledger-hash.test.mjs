import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { hashBytes, hashFile, hashTree, hashPath } from "../bin/util/ledger-hash.mjs";

function tempDir() {
  return mkdtempSync(join(tmpdir(), "ledger-hash-test-"));
}

function sha256Hex(text) {
  return createHash("sha256").update(text).digest("hex");
}

test("hashBytes prefixes the digest with sha256: and matches node:crypto", () => {
  const value = hashBytes("hello");
  assert.equal(value, `sha256:${sha256Hex("hello")}`);
  assert.match(value, /^sha256:[0-9a-f]{64}$/);
});

test("hashFile hashes raw bytes of a single file", () => {
  const dir = tempDir();
  const file = join(dir, "a.txt");
  writeFileSync(file, "content");
  assert.equal(hashFile(file), `sha256:${sha256Hex("content")}`);
  rmSync(dir, { recursive: true, force: true });
});

test("hashTree is order-independent and sensitive to content", () => {
  const dir = tempDir();
  mkdirSync(join(dir, "nested"));
  writeFileSync(join(dir, "b.txt"), "two");
  writeFileSync(join(dir, "nested", "a.txt"), "one");

  const first = hashTree(dir);

  // Recreate with the same content; digest must be stable across runs.
  const mirror = tempDir();
  mkdirSync(join(mirror, "nested"));
  writeFileSync(join(mirror, "nested", "a.txt"), "one");
  writeFileSync(join(mirror, "b.txt"), "two");
  assert.equal(hashTree(mirror), first);

  // Changing one file changes the tree hash.
  writeFileSync(join(mirror, "b.txt"), "changed");
  assert.notEqual(hashTree(mirror), first);

  rmSync(dir, { recursive: true, force: true });
  rmSync(mirror, { recursive: true, force: true });
});

test("hashTree encodes relpath and per-file sha as sorted nul-delimited lines", () => {
  const dir = tempDir();
  writeFileSync(join(dir, "z.txt"), "Z");
  writeFileSync(join(dir, "a.txt"), "A");

  const expectedLines = `a.txt\0${sha256Hex("A")}\n` + `z.txt\0${sha256Hex("Z")}\n`;
  assert.equal(hashTree(dir), `sha256:${sha256Hex(expectedLines)}`);

  rmSync(dir, { recursive: true, force: true });
});

test("hashTree skips symlinks and does not recurse into symlink cycles", () => {
  const dir = tempDir();
  writeFileSync(join(dir, "a.txt"), "alpha");
  mkdirSync(join(dir, "nested"));
  writeFileSync(join(dir, "nested", "b.txt"), "beta");

  const baseline = hashTree(dir);

  // A symlink pointing back at the root would make a naive walk recurse forever.
  symlinkSync(dir, join(dir, "nested", "loop"));

  assert.equal(hashTree(dir), baseline);

  rmSync(dir, { recursive: true, force: true });
});

test("hashPath returns null for an absent target", () => {
  assert.equal(hashPath(join(tempDir(), "does-not-exist")), null);
});

test("hashPath dispatches to file hash or tree hash by target kind", () => {
  const dir = tempDir();
  const file = join(dir, "f.txt");
  writeFileSync(file, "x");
  assert.equal(hashPath(file), hashFile(file));
  assert.equal(hashPath(dir), hashTree(dir));
  rmSync(dir, { recursive: true, force: true });
});
