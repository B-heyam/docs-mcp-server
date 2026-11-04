import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  closeClient,
  outputPathFrom,
  REAL_DOCS_DIR,
  startClient,
  textOf,
} from "../helpers.js";

const SOURCE_NAME = "pdf-.docx";

function hashOf(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

const sourcePath = path.join(REAL_DOCS_DIR, SOURCE_NAME);
const hashBefore = hashOf(await fs.readFile(sourcePath));

console.log(`DOCS_DIR: ${REAL_DOCS_DIR}`);
console.log(`Source file: ${sourcePath}`);
console.log(`SHA-256 before: ${hashBefore}`);

let client;

let failed = false;

try {
  client = await startClient(REAL_DOCS_DIR, "wps-docs-mcp-manual-replace");

  const result = await client.callTool({
    name: "replace_text_docx",
    arguments: {
      path: SOURCE_NAME,
      find: "AI",
      replace: "Artificial Intelligence",
    },
  });

  const text = textOf(result);

  console.log("\nreplace_text_docx result:");
  console.log(text);

  if (result.isError) {
    failed = true;
  } else {
    const outputPath = outputPathFrom(text);

    if (!outputPath) {
      console.error("No output file path was returned.");
      failed = true;
    } else {
      const stats = await fs.stat(outputPath);
      console.log(`\nOutput file path: ${outputPath}`);
      console.log(`Output file size: ${stats.size} bytes`);
    }
  }
} finally {
  await closeClient(client);
}

const hashAfter = hashOf(await fs.readFile(sourcePath));

console.log(`\nSHA-256 after:  ${hashAfter}`);
console.log(
  hashBefore === hashAfter
    ? "Original unchanged: YES (hashes match)"
    : "Original unchanged: NO (hashes differ)"
);

if (hashBefore !== hashAfter) failed = true;

if (failed) {
  process.exit(1);
}
