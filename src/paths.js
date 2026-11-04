import fs from "node:fs";
import path from "node:path";

/**
 * Returns the workspace directory from DOCS_DIR.
 * Throws a clear error when it is missing or not a usable directory.
 */
export function getDocsDir() {
  const raw = process.env.DOCS_DIR;

  if (raw === undefined || raw.trim() === "") {
    throw new Error(
      "DOCS_DIR environment variable is not set. " +
        "Set it to the folder that contains the documents, e.g. " +
        'DOCS_DIR="C:\\path\\to\\documents".'
    );
  }

  const docsDir = path.resolve(raw);

  let stats;
  try {
    stats = fs.statSync(docsDir);
  } catch {
    throw new Error(`DOCS_DIR does not exist or is not accessible: ${docsDir}`);
  }

  if (!stats.isDirectory()) {
    throw new Error(`DOCS_DIR is not a directory: ${docsDir}`);
  }

  return docsDir;
}

/**
 * Resolves relativePath inside DOCS_DIR.
 * Rejects absolute paths, NUL bytes, and anything that escapes DOCS_DIR
 * (including "..", "..\\..\\Windows\\system.ini", symlink-free traversal, etc.).
 */
export function resolveSafe(relativePath = ".") {
  if (typeof relativePath !== "string") {
    throw new Error("Path must be a string.");
  }

  if (relativePath.includes("\0")) {
    throw new Error("Path contains a NUL byte.");
  }

  const docsDir = getDocsDir();

  // path.resolve normalises "..", mixed separators and absolute inputs.
  const target = path.resolve(docsDir, relativePath);
  const rel = path.relative(docsDir, target);

  const escapes =
    rel === ".." ||
    rel.startsWith(`..${path.sep}`) ||
    path.isAbsolute(rel);

  if (escapes) {
    throw new Error(
      `Unsafe path rejected: "${relativePath}" resolves outside DOCS_DIR (${docsDir}).`
    );
  }

  return target;
}
