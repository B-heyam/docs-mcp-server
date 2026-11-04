import { spawnSync } from "node:child_process";

import { resolveSafe } from "../src/paths.js";
import {
  check,
  closeClient,
  failures,
  projectRoot,
  REAL_DOCS_DIR,
  recordFailure,
  serverEntry,
  startClient,
  textOf,
} from "./helpers.js";

// paths.js reads DOCS_DIR at call time, so this also covers the direct resolveSafe test.
process.env.DOCS_DIR = REAL_DOCS_DIR;

// 1. resolveSafe must reject a traversal outside DOCS_DIR.
let traversalRejected = false;
let traversalMessage = "";
try {
  resolveSafe("..\\..\\Windows\\system.ini");
} catch (error) {
  traversalRejected = true;
  traversalMessage = error.message;
}
check("resolveSafe rejects ..\\..\\Windows\\system.ini", traversalRejected, "no error thrown");
if (traversalRejected) console.log(`       reason: ${traversalMessage}`);

// 2. resolveSafe must still allow a normal relative path.
let normalPath = "";
try {
  normalPath = resolveSafe("report.pdf");
} catch (error) {
  console.error(`[FAIL] resolveSafe rejected a safe path: ${error.message}`);
  recordFailure();
}
check("resolveSafe accepts report.pdf", normalPath !== "");

// 3. Missing DOCS_DIR must fail with a clear startup error.
const noDocsEnv = { ...process.env };
delete noDocsEnv.DOCS_DIR;
const missingEnv = spawnSync(process.execPath, [serverEntry], {
  cwd: projectRoot,
  env: noDocsEnv,
  encoding: "utf8",
  timeout: 15000,
});
check(
  "server fails clearly when DOCS_DIR is missing",
  missingEnv.status === 1 && /DOCS_DIR environment variable is not set/.test(missingEnv.stderr),
  `status=${missingEnv.status} stderr=${missingEnv.stderr.trim()}`
);

// 4. End-to-end: spawn the server and call list_files through the SDK client.
let client;

try {
  client = await startClient(REAL_DOCS_DIR, "wps-docs-mcp-test");

  const { tools } = await client.listTools();
  console.log(`\nRegistered tools: ${tools.map((tool) => tool.name).join(", ")}`);
  check(
    "list_files is registered",
    tools.some((tool) => tool.name === "list_files")
  );

  const result = await client.callTool({ name: "list_files", arguments: {} });

  console.log("\nlist_files result:");
  console.log(JSON.stringify(result, null, 2));

  const text = textOf(result);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }

  check("list_files returned valid JSON", parsed !== undefined, text.slice(0, 200));
  if (parsed) {
    check("list_files returned an array of files", Array.isArray(parsed.files));
    check(
      "every entry is a .pdf or .docx with a KB size",
      parsed.files.every(
        (file) =>
          /\.(pdf|docx)$/i.test(file.name) &&
          typeof file.sizeKB === "number" &&
          file.sizeKB >= 0
      )
    );
    console.log(`       ${parsed.files.length} document(s) found.`);
  }
} finally {
  await closeClient(client);
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}

console.log("\nAll checks passed.");
