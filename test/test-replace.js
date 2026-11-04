import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  check,
  closeClient,
  failures,
  listDocuments,
  outputPathFrom,
  projectRoot,
  REAL_DOCS_DIR,
  recordFailure,
  startClient,
  textOf,
} from "./helpers.js";

function hashOf(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

const tempRoot = path.join(projectRoot, "test", ".tmp");
await fs.mkdir(tempRoot, { recursive: true });
const tempDir = await fs.mkdtemp(path.join(tempRoot, "replace-"));
process.env.DOCS_DIR = tempDir;

let client;

try {
  const realDocxFiles = await listDocuments(REAL_DOCS_DIR, ".docx");
  const sourceName =
    realDocxFiles.find((name) => name === "pdf-.docx") ?? realDocxFiles[0];
  if (!sourceName) throw new Error(`No .docx files found in ${REAL_DOCS_DIR}`);

  const realSourcePath = path.join(REAL_DOCS_DIR, sourceName);
  const copyPath = path.join(tempDir, sourceName);

  const originalHashBefore = hashOf(await fs.readFile(realSourcePath));
  await fs.copyFile(realSourcePath, copyPath);
  const copyHashBefore = hashOf(await fs.readFile(copyPath));

  console.log(`Source copied to temp workspace: ${copyPath}`);

  client = await startClient(tempDir, "wps-docs-mcp-replace-test");

  // 1. Read first, confirm the words we will search for really exist.
  const initial = await client.callTool({
    name: "read_docx",
    arguments: { path: sourceName },
  });
  const originalText = textOf(initial);
  check("read_docx on the copy succeeded", !initial.isError, originalText);

  const hasAi = originalText.includes("AI");
  const mainFind = hasAi ? "AI" : (originalText.match(/[A-Za-z]{3,}/) ?? [])[0];
  check('confirmed "AI" (or another word) exists in the document', Boolean(mainFind));
  const mainReplace = mainFind === "AI" ? "Artificial Intelligence" : "REPLACED_WORD";

  // 2. Default output name, replaces every occurrence, original untouched.
  const mainResult = await client.callTool({
    name: "replace_text_docx",
    arguments: { path: sourceName, find: mainFind, replace: mainReplace },
  });
  const mainText = textOf(mainResult);

  console.log("\n=== replace_text_docx (default output) ===");
  console.log(mainText);

  check("replace_text_docx succeeded", !mainResult.isError, mainText);
  const mainCount = Number((mainText.match(/Replacements:\s*(\d+)/) ?? [])[1]);
  check("reported at least one replacement", mainCount >= 1, mainText);

  const mainOutputPath = outputPathFrom(mainText);

  check("returned an output file path", Boolean(mainOutputPath), mainText);
  const expectedDefaultName = `${path.parse(sourceName).name}_edited.docx`;
  check(
    "default output name is <original>_edited.docx",
    path.basename(mainOutputPath ?? "") === expectedDefaultName,
    `${path.basename(mainOutputPath ?? "")} != ${expectedDefaultName}`
  );
  check("output file exists", Boolean(mainOutputPath && (await fs.stat(mainOutputPath).catch(() => null))));

  const editedRead = await client.callTool({
    name: "read_docx",
    arguments: { path: path.basename(mainOutputPath) },
  });
  const editedText = textOf(editedRead);
  check("edited file is readable", !editedRead.isError, editedText);
  check(`edited file contains "${mainReplace}"`, editedText.includes(mainReplace));
  check(
    `all "${mainFind}" occurrences were replaced`,
    editedText.split(mainFind).length - 1 === 0,
    `remaining: ${editedText.split(mainFind).length - 1}`
  );

  const originalHashAfterMain = hashOf(await fs.readFile(realSourcePath));
  const copyHashAfterMain = hashOf(await fs.readFile(copyPath));
  check(
    "original document in DOCS_DIR is unchanged (SHA-256)",
    originalHashAfterMain === originalHashBefore,
    `${originalHashBefore} -> ${originalHashAfterMain}`
  );
  check(
    "source copy is unchanged (SHA-256)",
    copyHashAfterMain === copyHashBefore
  );

  // 3. Arabic find/replace, including text split across runs ("الذكاء" is split in this document).
  const arabicFind = "الذكاء";
  const arabicReplace = "الذكاء الاصطناعي";
  check(`Arabic find text "${arabicFind}" exists in the document`, originalText.includes(arabicFind));

  const arabicResult = await client.callTool({
    name: "replace_text_docx",
    arguments: {
      path: sourceName,
      find: arabicFind,
      replace: arabicReplace,
      output: "arabic_test.docx",
    },
  });
  const arabicText = textOf(arabicResult);

  console.log("\n=== replace_text_docx (Arabic, explicit output) ===");
  console.log(arabicText);

  check("Arabic replace_text_docx succeeded", !arabicResult.isError, arabicText);
  const arabicCount = Number((arabicText.match(/Replacements:\s*(\d+)/) ?? [])[1]);
  check("Arabic replacement count is at least one", arabicCount >= 1, arabicText);

  const arabicRead = await client.callTool({
    name: "read_docx",
    arguments: { path: "arabic_test.docx" },
  });
  const arabicOut = textOf(arabicRead);
  check("Arabic output is readable", !arabicRead.isError, arabicOut);
  check("Arabic output contains the replacement", arabicOut.includes(arabicReplace));
  check("Arabic output has no U+FFFD (no mangling)", !arabicOut.includes("\uFFFD"));
  check("Arabic output has no ????? sequences", !/\?{4,}/.test(arabicOut));

  const arabicSnippetIndex = arabicOut.indexOf(arabicReplace);
  const arabicSnippet = arabicOut
    .slice(Math.max(0, arabicSnippetIndex - 40), arabicSnippetIndex + arabicReplace.length + 60)
    .replace(/\s+/g, " ");
  console.log(`Arabic output snippet: ${arabicSnippet}`);
  console.log(
    `Replacement codepoints: ${[...arabicReplace]
      .map((char) => "U+" + char.codePointAt(0).toString(16).toUpperCase())
      .join(" ")}`
  );

  // 4. A second write to the same output name must create _2, not overwrite.
  const firstArabicHash = hashOf(await fs.readFile(path.join(tempDir, "arabic_test.docx")));
  const duplicateResult = await client.callTool({
    name: "replace_text_docx",
    arguments: {
      path: sourceName,
      find: arabicFind,
      replace: arabicReplace,
      output: "arabic_test.docx",
    },
  });
  const duplicateText = textOf(duplicateResult);
  console.log("\n=== replace_text_docx (same output name again) ===");
  console.log(duplicateText);

  const duplicatePath = outputPathFrom(duplicateText);
  check(
    "existing output is never overwritten (created _2)",
    path.basename(duplicatePath ?? "") === "arabic_test_2.docx",
    path.basename(duplicatePath ?? "")
  );
  check(
    "first Arabic output is unchanged",
    hashOf(await fs.readFile(path.join(tempDir, "arabic_test.docx"))) === firstArabicHash
  );

  // 5. Zero matches: no file created, no error.
  const filesBeforeZero = (await listDocuments(tempDir, ".docx")).length;
  const zeroResult = await client.callTool({
    name: "replace_text_docx",
    arguments: {
      path: sourceName,
      find: "ZZZ_NOT_PRESENT_98765",
      replace: "x",
    },
  });
  const zeroText = textOf(zeroResult);
  console.log("\n=== replace_text_docx (0 matches) ===");
  console.log(zeroText);

  check("0-match call is not an error", !zeroResult.isError);
  check("0-match result reports Replacements: 0", /Replacements:\s*0/.test(zeroText));
  check("0-match result says no file was created", /No file was created/i.test(zeroText));
  check(
    "0-match call created no file",
    (await listDocuments(tempDir, ".docx")).length === filesBeforeZero
  );

  // 6. Clear errors, not crashes.
  const missing = await client.callTool({
    name: "replace_text_docx",
    arguments: { path: "missing.docx", find: "a", replace: "b" },
  });
  check(
    "missing source returns a clear isError",
    missing.isError && /File not found in DOCS_DIR/.test(textOf(missing)),
    textOf(missing)
  );

  const wrongOutput = await client.callTool({
    name: "replace_text_docx",
    arguments: { path: sourceName, find: "AI", replace: "x", output: "out.txt" },
  });
  check(
    "non-.docx output is rejected",
    wrongOutput.isError && /Output must end with \.docx/.test(textOf(wrongOutput)),
    textOf(wrongOutput)
  );

  const overwriteOriginal = await client.callTool({
    name: "replace_text_docx",
    arguments: { path: sourceName, find: "AI", replace: "x", output: sourceName },
  });
  check(
    "overwriting the original is refused",
    overwriteOriginal.isError && /Refusing to overwrite the original/.test(textOf(overwriteOriginal)),
    textOf(overwriteOriginal)
  );

  const brokenPath = path.join(tempDir, "broken.docx");
  await fs.writeFile(brokenPath, "this is not a zip file");
  const broken = await client.callTool({
    name: "replace_text_docx",
    arguments: { path: "broken.docx", find: "a", replace: "b" },
  });
  check(
    "bad zip returns a clear isError",
    broken.isError && /not a valid \.docx/.test(textOf(broken)),
    textOf(broken)
  );

  const originalHashFinal = hashOf(await fs.readFile(realSourcePath));
  check(
    "original document still unchanged after all tests",
    originalHashFinal === originalHashBefore
  );
  console.log(`\nOriginal SHA-256 (before and after): ${originalHashBefore}`);
} catch (error) {
  recordFailure();
  console.error(`[FAIL] unexpected error: ${error.stack ?? error.message}`);
} finally {
  await closeClient(client, true);
  await fs.rm(tempDir, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}

console.log("\nAll checks passed.");
