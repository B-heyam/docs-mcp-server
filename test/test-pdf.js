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

const PDF_A = "66811.pdf";
const PDF_B = "Docker_Based_Big_Data_Platform_DrNaik.pdf";

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

async function pdfPageCount(filePath) {
  const doc = await PDFDocument.load(await fs.readFile(filePath));
  return doc.getPageCount();
}

const tempRoot = path.join(projectRoot, "test", ".tmp");
await fs.mkdir(tempRoot, { recursive: true });
const tempDir = await fs.mkdtemp(path.join(tempRoot, "pdf-"));

let tempClient;
let realClient;

try {
  // Temp copies: the originals in DOCS_DIR must never be modified.
  const originalAPath = path.join(REAL_DOCS_DIR, PDF_A);
  const originalBPath = path.join(REAL_DOCS_DIR, PDF_B);
  const hashABefore = await sha256(originalAPath);
  const hashBBefore = await sha256(originalBPath);

  await fs.copyFile(originalAPath, path.join(tempDir, PDF_A));
  await fs.copyFile(originalBPath, path.join(tempDir, PDF_B));

  const sourceAPages = await pdfPageCount(path.join(tempDir, PDF_A));
  const sourceBPages = await pdfPageCount(path.join(tempDir, PDF_B));
  console.log(`Source page counts: ${PDF_A}=${sourceAPages}, ${PDF_B}=${sourceBPages}`);

  tempClient = await startClient(tempDir, "wps-docs-mcp-pdf-temp");
  realClient = await startClient(REAL_DOCS_DIR, "wps-docs-mcp-pdf-real");

  // Reference text for page order checks.
  const sourceATwo = await readPdf(tempClient, PDF_A, "1-2");
  check("read_pdf source pages 1-2 succeeded", !sourceATwo.result.isError, sourceATwo.text);
  const sourceATexts = pageTexts(sourceATwo.text, true);
  check("source has two readable pages", sourceATexts.length === 2);

  // --- Extract "1-2" ---
  const extract12 = await tempClient.callTool({
    name: "pdf_extract_pages",
    arguments: { path: PDF_A, pages: "1-2", output: "extract_1_2.pdf" },
  });
  const extract12Text = textOf(extract12);
  console.log("\n=== pdf_extract_pages: 1-2 ===");
  console.log(extract12Text);
  check("extract 1-2 succeeded", !extract12.isError, extract12Text);
  check("extract 1-2 reports page count 2", pageCountFrom(extract12Text) === 2, extract12Text);

  const extract12Path = outputPathFrom(extract12Text);
  const read12 = await readPdf(tempClient, path.basename(extract12Path ?? "extract_1_2.pdf"));
  check("read_pdf on extract 1-2 succeeded", !read12.result.isError, read12.text);
  const extract12Pages = pageTexts(read12.text, true);
  check("extract 1-2 contains 2 pages", extract12Pages.length === 2);
  check(
    "extract 1-2 kept page order 1,2",
    extract12Pages[0] === sourceATexts[0] && extract12Pages[1] === sourceATexts[1]
  );

  // --- Extract "2,1" (order must be preserved) ---
  const extract21 = await tempClient.callTool({
    name: "pdf_extract_pages",
    arguments: { path: PDF_A, pages: "2,1", output: "extract_2_1.pdf" },
  });
  const extract21Text = textOf(extract21);
  console.log("\n=== pdf_extract_pages: 2,1 ===");
  console.log(extract21Text);
  check("extract 2,1 succeeded", !extract21.isError, extract21Text);
  check("extract 2,1 reports page count 2", pageCountFrom(extract21Text) === 2, extract21Text);

  const extract21Path = outputPathFrom(extract21Text);
  const read21 = await readPdf(tempClient, path.basename(extract21Path ?? "extract_2_1.pdf"));
  check("read_pdf on extract 2,1 succeeded", !read21.result.isError, read21.text);
  const extract21Pages = pageTexts(read21.text, true);
  check("extract 2,1 contains 2 pages", extract21Pages.length === 2);
  check(
    "extract 2,1 kept page order 2,1",
    extract21Pages[0] === sourceATexts[1] && extract21Pages[1] === sourceATexts[0]
  );

  // --- Default output name ---
  const extractDefault = await tempClient.callTool({
    name: "pdf_extract_pages",
    arguments: { path: PDF_A, pages: String(sourceAPages) },
  });
  const extractDefaultText = textOf(extractDefault);
  check("extract with default output succeeded", !extractDefault.isError, extractDefaultText);
  check(
    "default output is <original>_pages.pdf",
    path.basename(outputPathFrom(extractDefaultText) ?? "") === "66811_pages.pdf",
    outputPathFrom(extractDefaultText)
  );

  // --- Invalid page selections ---
  const invalidCases = [
    { pages: "999", expected: /outside the document|page\(s\)/i, label: 'invalid page "999"' },
    { pages: "0", expected: /start at 1|0 is not allowed/i, label: 'invalid page "0"' },
    { pages: "3-1", expected: /greater than the end page/i, label: 'reversed range "3-1"' },
  ];

  for (const invalidCase of invalidCases) {
    const result = await tempClient.callTool({
      name: "pdf_extract_pages",
      arguments: {
        path: PDF_A,
        pages: invalidCase.pages,
        output: `extract_invalid_${invalidCase.pages.replace(/\W/g, "_")}.pdf`,
      },
    });
    const message = textOf(result);
    console.log(`\n=== pdf_extract_pages: ${invalidCase.label} ===`);
    console.log(message);
    check(`${invalidCase.label} returns isError`, result.isError === true, message);
    check(`${invalidCase.label} has a clear message`, invalidCase.expected.test(message), message);

    const outputFile = path.join(
      tempDir,
      `extract_invalid_${invalidCase.pages.replace(/\W/g, "_")}.pdf`
    );
    check(
      `${invalidCase.label} created no file`,
      !(await fs.stat(outputFile).catch(() => null))
    );
  }

  // --- Merge both temp PDFs ---
  const merge = await tempClient.callTool({
    name: "merge_pdfs",
    arguments: { paths: [PDF_A, PDF_B], output: "merged_temp.pdf" },
  });
  const mergeText = textOf(merge);
  console.log("\n=== merge_pdfs: both PDFs ===");
  console.log(mergeText);
  check("merge_pdfs succeeded", !merge.isError, mergeText);

  const expectedTotal = sourceAPages + sourceBPages;
  check(
    `merged page count equals the sum (${expectedTotal})`,
    pageCountFrom(mergeText) === expectedTotal,
    mergeText
  );

  const mergedPath = outputPathFrom(mergeText);
  const readMergedFirst = await readPdf(
    tempClient,
    path.basename(mergedPath ?? "merged_temp.pdf"),
    "1"
  );
  check("read_pdf on merged file succeeded", !readMergedFirst.result.isError, readMergedFirst.text);
  const mergedFirstTexts = pageTexts(readMergedFirst.text, true);
  check(
    "merged page 1 is the first page of the first PDF",
    mergedFirstTexts.length === 1 && mergedFirstTexts[0] === sourceATexts[0]
  );

  const sourceBFirst = await readPdf(tempClient, PDF_B, "1");
  check("read_pdf source B page 1 succeeded", !sourceBFirst.result.isError, sourceBFirst.text);
  const sourceBTexts = pageTexts(sourceBFirst.text, true);

  const readMergedSecondPart = await readPdf(
    tempClient,
    path.basename(mergedPath ?? "merged_temp.pdf"),
    String(sourceAPages + 1)
  );
  check(
    "read_pdf on merged page after the first PDF succeeded",
    !readMergedSecondPart.result.isError,
    readMergedSecondPart.text
  );
  const mergedSecondTexts = pageTexts(readMergedSecondPart.text, true);
  check(
    "merged page after A is the first page of the second PDF",
    mergedSecondTexts.length === 1 && mergedSecondTexts[0] === sourceBTexts[0]
  );

  // Originals untouched by all temp operations.
  check("original PDF A unchanged (SHA-256)", (await sha256(originalAPath)) === hashABefore);
  check("original PDF B unchanged (SHA-256)", (await sha256(originalBPath)) === hashBBefore);

  // --- One persistent merged sample in the real DOCS_DIR ---
  // Only create it when the exact name is free; otherwise skip.
  const persistentPath = path.join(REAL_DOCS_DIR, "merged_sample.pdf");
  const persistentExists = await fs
    .stat(persistentPath)
    .then(() => true)
    .catch(() => false);

  if (persistentExists) {
    console.log("persistent sample already exists, skipped");
  } else {
    const mergeReal = await realClient.callTool({
      name: "merge_pdfs",
      arguments: { paths: [PDF_A, PDF_B], output: "merged_sample.pdf" },
    });
    const mergeRealText = textOf(mergeReal);
    console.log("\n=== merge_pdfs: persistent sample in real DOCS_DIR ===");
    console.log(mergeRealText);
    check("persistent merge succeeded", !mergeReal.isError, mergeRealText);
    check(
      `persistent merge page count equals the sum (${expectedTotal})`,
      pageCountFrom(mergeRealText) === expectedTotal,
      mergeRealText
    );

    check(
      "persistent file was created as merged_sample.pdf",
      Boolean(await fs.stat(persistentPath).catch(() => null))
    );

    const readPersistent = await readPdf(realClient, "merged_sample.pdf");
    check(
      "persistent merged file is readable with read_pdf",
      !readPersistent.result.isError,
      readPersistent.text
    );
    const persistentPages = pageTexts(readPersistent.text, true);
    check(
      "persistent merged file has the expected page count",
      persistentPages.length === expectedTotal,
      String(persistentPages.length)
    );
    console.log(`\nPersistent merged file: ${persistentPath}`);
  }

  check(
    "original PDF A unchanged after persistent merge (SHA-256)",
    (await sha256(originalAPath)) === hashABefore
  );
  check(
    "original PDF B unchanged after persistent merge (SHA-256)",
    (await sha256(originalBPath)) === hashBBefore
  );
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
