import {
  check,
  closeClient,
  failures,
  REAL_DOCS_DIR,
  startClient,
  textOf,
} from "./helpers.js";

process.env.DOCS_DIR = REAL_DOCS_DIR;

let client;

try {
  client = await startClient(REAL_DOCS_DIR, "wps-docs-mcp-read-test");

  const listResult = await client.callTool({ name: "list_files", arguments: {} });
  const listing = JSON.parse(textOf(listResult));
  check("list_files returned documents", !listResult.isError && listing.files.length > 0);

  const docx = listing.files.find(
    (file) => !file.name.startsWith("~$") && /\.docx$/i.test(file.name)
  );
  const pdf = listing.files.find(
    (file) => !file.name.startsWith("~$") && /\.pdf$/i.test(file.name)
  );
  check("found a .docx to read", Boolean(docx), "none in DOCS_DIR");
  check("found a .pdf to read", Boolean(pdf), "none in DOCS_DIR");

  // --- read_docx ---
  if (docx) {
    const result = await client.callTool({
      name: "read_docx",
      arguments: { path: docx.name },
    });
    const text = textOf(result);

    check("read_docx succeeded", !result.isError, text);
    console.log(`\n=== read_docx: ${docx.name} (first 500 characters) ===`);
    console.log(text.slice(0, 500));
    console.log(`\n[full text length: ${text.length} characters]`);

    // Arabic must be intact UTF-8: real Arabic letters, no U+FFFD, no "?????".
    const arabicChars = text.match(/[\u0600-\u06FF]/g) ?? [];
    const arabicRuns =
      text.match(/[\u0600-\u06FF]+(?:[\s\u064B-\u065F\u0670\u0640]+[\u0600-\u06FF]+)*/g) ?? [];
    const normalizedArabic = text.replace(/[\u064B-\u065F\u0670\u0640]/g, "");

    check("read_docx contains Arabic characters", arabicChars.length > 0, `${arabicChars.length} found`);
    check("no Unicode replacement character (U+FFFD)", !text.includes("\uFFFD"));
    check("no mangled ????? sequences", !/\?{4,}/.test(text));
    check(
      'Arabic is in logical order (normalized text contains "الله")',
      normalizedArabic.includes("الله")
    );

    console.log("\nArabic samples:");
    for (const run of arabicRuns.slice(0, 3)) {
      console.log(`  ${run}`);
      console.log(`  codepoints: ${[...run].map((char) => "U+" + char.codePointAt(0).toString(16).toUpperCase()).join(" ")}`);
    }
  }

  // --- read_pdf ---
  if (pdf) {
    const result = await client.callTool({
      name: "read_pdf",
      arguments: { path: pdf.name, pages: "1-2" },
    });
    const text = textOf(result);

    check("read_pdf succeeded", !result.isError, text);
    check("read_pdf has page 1 marker", text.includes("--- Page 1 ---"));
    check("read_pdf has page 2 marker", text.includes("--- Page 2 ---"));
    check("read_pdf respected pages=1-2", !text.includes("--- Page 3 ---"));
    check(
      "read_pdf returns text or an explicit scanned-page note",
      text.replace(/--- Page \d+ ---/g, "").trim().length > 0
    );

    console.log(`\n=== read_pdf: ${pdf.name}, pages=1-2 (first 500 characters) ===`);
    console.log(text.slice(0, 500));
    console.log(`\n[full text length: ${text.length} characters]`);
  }

  // --- clear errors, not crashes ---
  if (pdf && docx) {
    const wrongExtension = await client.callTool({
      name: "read_docx",
      arguments: { path: pdf.name },
    });
    check(
      "read_docx rejects a .pdf path with a clear error",
      wrongExtension.isError && /Expected a \.docx file/.test(textOf(wrongExtension)),
      textOf(wrongExtension)
    );

    const missingFile = await client.callTool({
      name: "read_pdf",
      arguments: { path: "does-not-exist.pdf" },
    });
    check(
      "read_pdf reports a missing file clearly",
      missingFile.isError && /File not found in DOCS_DIR/.test(textOf(missingFile)),
      textOf(missingFile)
    );

    const missingDocx = await client.callTool({
      name: "read_docx",
      arguments: { path: "does-not-exist.docx" },
    });
    check(
      "read_docx reports a missing file clearly",
      missingDocx.isError && /File not found in DOCS_DIR/.test(textOf(missingDocx)),
      textOf(missingDocx)
    );
  }
} finally {
  await closeClient(client);
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}

console.log("\nAll checks passed.");
