// Apply-ledger hashing. Deliberately distinct from skillContentHash: the ledger attests exact on-disk bytes, so it uses full sha256 with no manifest-casing normalization and no truncation.

import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export function hashBytes(buffer) {
  return `sha256:${createHash("sha256").update(buffer).digest("hex")}`;
}

export function hashFile(path) {
  return hashBytes(readFileSync(path));
}

// Directory tree hash: sha256 over sorted `relpath \0 contentSha256 \n` lines so the
// digest is path-stable and independent of readdir order across platforms.
export function hashTree(root) {
  const lines = collectTreeFiles(root)
    .sort()
    .map(
      (rel) =>
        `${rel}\0${createHash("sha256")
          .update(readFileSync(join(root, rel)))
          .digest("hex")}\n`
    )
    .join("");
  return hashBytes(lines);
}

export function hashPath(path) {
  if (!existsSync(path)) return null;
  return statSync(path).isDirectory() ? hashTree(path) : hashFile(path);
}

function collectTreeFiles(root) {
  const files = [];
  walk(root, root, files);
  return files;
}

function walk(root, dir, files) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    // Skip symlinks: prevents infinite recursion on cyclic links, and the ledger attests real on-disk bytes only.
    const st = lstatSync(full);
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) {
      walk(root, full, files);
    } else {
      files.push(relative(root, full));
    }
  }
}
