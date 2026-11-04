import fs from "node:fs/promises";
import path from "node:path";

import { resolveSafe } from "../paths.js";

const MAX_NAME_ATTEMPTS = 10000;

/**
 * Resolves the requested document inside DOCS_DIR, enforces the expected
 * extension, and checks that it is an existing, readable file.
 * Returns { filePath, displayPath }.
 */
export async function resolveDocument(relativePath, expectedExtension) {
  const filePath = resolveSafe(relativePath);
  const extension = path.extname(relativePath).toLowerCase();

  if (extension !== expectedExtension) {
    throw new Error(
      `Expected a ${expectedExtension} file, got "${relativePath}".`
    );
  }

  let stats;
  try {
    stats = await fs.stat(filePath);
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(`File not found in DOCS_DIR: ${relativePath}`);
    }
    throw new Error(`Cannot access "${relativePath}": ${error.message}`);
  }

  if (!stats.isFile()) {
    throw new Error(`Not a file: ${relativePath}`);
  }

  return { filePath, displayPath: relativePath };
}

export function fileNameWithSuffix(filePath, suffix) {
  const extension = path.extname(filePath);
  const stem = filePath.slice(0, filePath.length - extension.length);
  return `${stem}${suffix}${extension}`;
}

export async function writeNewFile(candidatePath, data) {
  for (let attempt = 1; attempt <= MAX_NAME_ATTEMPTS; attempt += 1) {
    const target =
      attempt === 1 ? candidatePath : fileNameWithSuffix(candidatePath, `_${attempt}`);

    try {
      const stats = await fs.stat(target);
      if (stats.isDirectory()) {
        throw new Error(`Output path is a directory: ${target}`);
      }
      continue; // Exists: try the next _2, _3, ... name.
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }

    try {
      await fs.writeFile(target, data, { flag: "wx" });
      return target;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
  }

  throw new Error("Could not find an unused output file name.");
}
