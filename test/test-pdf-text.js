import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { PDFDocument } from "pdf-lib";

import {
  check,
  closeClient,
  failures,
  outputPathFrom,
  pageTexts,
  projectRoot,
  REAL_DOCS_DIR,
  readPdf,
  recordFailure,
  startClient,
  textOf,
} from "./helpers.js";

const SOURCE_PDF = "66811.pdf";

const ARABIC_TEXT = "مرحبا بالعالم - Hello";
const FRENCH_TEXT = "Résumé français : élève, garçon, déjà";
const ENGLISH_TEXT = "Added by pdf_add_text - English line";

const ARABIC_PRESENTATION_FORMS = /[\uFB50-\uFDFF\uFE70-\uFEFF]/;

function pageCountFrom(text) {
  const match = /^Page count:\s*(\d+)$/m.exec(text);
  return match ? Number(match[1]) : undefined;
}

async function sha256(filePath) {
  return crypto
    .createHash("sha256")
    .update(await fs.readFile(filePath))
    .digest("hex");
}

async function firstPageWidth(filePath) {
  const doc = await PDFDocument.load(await fs.readFile(filePath));
  return doc.getPage(0).getWidth();
}

function buildItems(pageWidth) {
  return [
    {
      page: 1,
      text: ENGLISH_TEXT,
      x: 72,
      y: 90,
      size: 14,
      color: "#1F4E79",
    },
    {
      page: 1,
      text: FRENCH_TEXT,
      x: 72,
      y: 70,
      size: 14,
      font: "latin",
    },
    {
      page: 1,
      text: ARABIC_TEXT,
      x: pageWidth - 72,
      y: 50,
      size: 16,
      rtl: true,
      font: "arabic",
    },
  ];
}

const tempRoot = path.join(projectRoot, "test", ".tmp");
await fs.mkdir(tempRoot, { recursive: true });
const tempDir = await fs.mkdtemp(path.join(tempRoot, "pdf-text-"));

let tempClient;
let realClient;

try {
  // Temp copy: the original in DOCS_DIR must never be modified.
  const originalPath = path.join(REAL_DOCS_DIR, SOURCE_PDF);
  const hashBefore = await sha256(originalPath);

  const tempCopyPath = path.join(tempDir, SOURCE_PDF);
  await fs.copyFile(originalPath, tempCopyPath);
  const tempCopyHashBefore = await sha256(tempCopyPath);

  const originalPageCount = (await PDFDocument.load(await fs.readFile(originalPath)))
    .getPageCount();
  const pageWidth = await firstPageWidth(tempCopyPath);

  tempClient = await startClient(tempDir, "wps-docs-mcp-pdf-text-temp");
  realClient = await startClient(REAL_DOCS_DIR, "wps-docs-mcp-pdf-text-real");

  // --- Add the three lines to the temp copy ---
  const added = await tempClient.callTool({
    name: "pdf_add_text",
    arguments: {
      path: SOURCE_PDF,
      output: "text_test.pdf",
      items: buildItems(pageWidth),
    },
  });
  const addedText = textOf(added);
  console.log("\n=== pdf_add_text: English + French + Arabic ===");
  console.log(addedText);

  check("pdf_add_text succeeded", !added.isError, addedText);
  check(
    `reported page count is unchanged (${originalPageCount})`,
    pageCountFrom(addedText) === originalPageCount,
    addedText
  );

  const addedPath = outputPathFrom(addedText);
  check(
    "output file exists",
    Boolean(addedPath && (await fs.stat(addedPath).catch(() => null)))
  );

  const read = await readPdf(tempClient, path.basename(addedPath ?? "text_test.pdf"));
  check("read_pdf on the output succeeded", !read.result.isError, read.text);
  const pages = pageTexts(read.text);
  check(
    `read_pdf still finds ${originalPageCount} pages`,
    pages.length === originalPageCount,
    String(pages.length)
  );

  const pageOne = pages[0] ?? "";
  console.log("\n=== Extracted page 1 (first 700 characters) ===");
  console.log(pageOne.slice(0, 700));

  check("English line is extractable", pageOne.includes(ENGLISH_TEXT));
  check("French line is extractable", pageOne.includes(FRENCH_TEXT));
  check("French accents survive (é, ç, à)", ["é", "ç", "à"].every((c) => pageOne.includes(c)));

  const arabicLine = pageOne
    .split(/\r?\n/)
    .find((line) => ARABIC_PRESENTATION_FORMS.test(line) && line.includes("Hello"));
  check("Arabic line is extractable with presentation forms", Boolean(arabicLine), pageOne);
  console.log(`Arabic extracted as: ${JSON.stringify(arabicLine ?? "")}`);

  check("no U+FFFD replacement characters", !read.text.includes("\uFFFD"));
  check("no ????? mangling", !/\?{4,}/.test(read.text));

  // --- Default output name ---
  const defaultOut = await tempClient.callTool({
    name: "pdf_add_text",
    arguments: {
      path: SOURCE_PDF,
      items: [{ page: 1, text: "Default output name check", x: 72, y: 610 }],
    },
  });
  const defaultOutText = textOf(defaultOut);
  check("default-output call succeeded", !defaultOut.isError, defaultOutText);
  check(
    "default output is <original>_text.pdf",
    path.basename(outputPathFrom(defaultOutText) ?? "") === "66811_text.pdf",
    outputPathFrom(defaultOutText)
  );

  // --- Invalid page numbers ---
  const invalidCases = [
    { page: 999, label: "page 999", expected: /outside the document|page\(s\)/i },
    { page: 0, label: "page 0", expected: /page numbers start at 1/i },
  ];

  for (const invalidCase of invalidCases) {
    const outputName = `text_invalid_${invalidCase.page}.pdf`;
    const result = await tempClient.callTool({
      name: "pdf_add_text",
      arguments: {
        path: SOURCE_PDF,
        output: outputName,
        items: [{ page: invalidCase.page, text: "should not be written", x: 72, y: 610 }],
      },
    });
    const message = textOf(result);
    console.log(`\n=== pdf_add_text: invalid ${invalidCase.label} ===`);
    console.log(message);
    check(`${invalidCase.label} returns isError`, result.isError === true, message);
    check(`${invalidCase.label} has a clear message`, invalidCase.expected.test(message), message);
    check(
      `${invalidCase.label} created no file`,
      !(await fs.stat(path.join(tempDir, outputName)).catch(() => null))
    );
  }

  check("original PDF unchanged after temp operations (SHA-256)", (await sha256(originalPath)) === hashBefore);
  check(
    "source copy unchanged by pdf_add_text (SHA-256)",
    (await sha256(tempCopyPath)) === tempCopyHashBefore
  );

  // --- One persistent file in the real DOCS_DIR ---
  // Only create it when the exact name is free; otherwise skip.
  const persistentPath = path.join(REAL_DOCS_DIR, "text_sample.pdf");
  const persistentExists = await fs
    .stat(persistentPath)
    .then(() => true)
    .catch(() => false);

  if (persistentExists) {
    console.log("persistent sample already exists, skipped");
  } else {
    const realWidth = await firstPageWidth(originalPath);
    const persistent = await realClient.callTool({
      name: "pdf_add_text",
      arguments: {
        path: SOURCE_PDF,
        output: "text_sample.pdf",
        items: buildItems(realWidth),
      },
    });
    const persistentText = textOf(persistent);
    console.log("\n=== pdf_add_text: persistent sample in real DOCS_DIR ===");
    console.log(persistentText);
    check("persistent pdf_add_text succeeded", !persistent.isError, persistentText);
    check(
      `persistent file page count is unchanged (${originalPageCount})`,
      pageCountFrom(persistentText) === originalPageCount,
      persistentText
    );

    check(
      "persistent file was created as text_sample.pdf",
      Boolean(await fs.stat(persistentPath).catch(() => null))
    );

    const readPersistent = await readPdf(realClient, "text_sample.pdf");
    check(
      "persistent file is readable with read_pdf",
      !readPersistent.result.isError,
      readPersistent.text
    );
    const persistentPages = pageTexts(readPersistent.text);
    check(
      `persistent file still has ${originalPageCount} pages`,
      persistentPages.length === originalPageCount,
      String(persistentPages.length)
    );
    const persistentPageOne = persistentPages[0] ?? "";
    check("persistent file contains the French line", persistentPageOne.includes(FRENCH_TEXT));
    check(
      "persistent file contains Arabic presentation forms",
      ARABIC_PRESENTATION_FORMS.test(persistentPageOne)
    );
    console.log(`\nPersistent text file: ${persistentPath}`);
  }

  check("original PDF unchanged after persistent run (SHA-256)", (await sha256(originalPath)) === hashBefore);
} catch (error) {
  recordFailure();
  console.error(`[FAIL] unexpected error: ${error.stack ?? error.message}`);
} finally {
  await closeClient(tempClient, true);
  await closeClient(realClient, true);
  await fs.rm(tempDir, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}

console.log("\nAll checks passed.");
