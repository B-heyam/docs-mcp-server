import fs from "node:fs/promises";
import path from "node:path";

import JSZip from "jszip";

import {
  check,
  closeClient,
  failures,
  outputPathFrom,
  projectRoot,
  REAL_DOCS_DIR,
  recordFailure,
  startClient,
  textOf,
} from "./helpers.js";

async function inspectDocx(filePath) {
  const zip = await JSZip.loadAsync(await fs.readFile(filePath));
  const parts = {};

  for (const name of Object.keys(zip.files)) {
    if (/^word\/.*\.xml$/i.test(name)) {
      parts[name] = await zip.file(name).async("string");
    }
  }

  const footers = Object.entries(parts)
    .filter(([name]) => /^word\/footer\d*\.xml$/i.test(name))
    .map(([, xml]) => xml)
    .join("\n");

  return {
    document: parts["word/document.xml"] ?? "",
    styles: parts["word/styles.xml"] ?? "",
    footers,
    all: Object.values(parts).join("\n"),
  };
}

async function createAndRead(client, spec, expectedStrings, label) {
  const created = await client.callTool({
    name: "create_docx",
    arguments: spec,
  });
  const createdText = textOf(created);

  console.log(`\n=== create_docx: ${label} ===`);
  console.log(createdText);

  check(`${label}: create_docx succeeded`, !created.isError, createdText);

  const outputPath = outputPathFrom(createdText);
  check(`${label}: returned output file path`, Boolean(outputPath), createdText);
  check(
    `${label}: output file exists`,
    Boolean(outputPath && (await fs.stat(outputPath).catch(() => null)))
  );

  const read = await client.callTool({
    name: "read_docx",
    arguments: { path: path.basename(outputPath ?? spec.output) },
  });
  const text = textOf(read);

  check(`${label}: read_docx succeeded`, !read.isError, text);

  for (const expected of expectedStrings) {
    check(`${label}: contains "${expected}"`, text.includes(expected));
  }

  check(`${label}: no U+FFFD replacement characters`, !text.includes("\uFFFD"));
  check(`${label}: no ????? mangling`, !/\?{4,}/.test(text));

  return { text, outputPath };
}

const tempRoot = path.join(projectRoot, "test", ".tmp");
await fs.mkdir(tempRoot, { recursive: true });
const tempDir = await fs.mkdtemp(path.join(tempRoot, "create-"));

let tempClient;
let realClient;

const arabicBlocks = [
  { type: "heading", text: "مقدمة", level: 1 },
  {
    type: "paragraph",
    text: "هذا نص عربي يحتوي على كلمة française للاختبار، مع أرقام ١٢٣.",
  },
  {
    type: "bullets",
    items: ["النقطة الأولى", "النقطة الثانية", "Point en français"],
  },
  {
    type: "table",
    rows: [
      ["الاسم", "القيمة"],
      ["أحمد", "١٢٣"],
      ["Paris", "France"],
    ],
  },
];

const frenchBlocks = [
  { type: "heading", text: "Introduction", level: 1 },
  {
    type: "paragraph",
    text: "Ceci est un paragraphe en français avec le mot arabe العربية.",
    align: "justify",
  },
  { type: "bullets", items: ["Premier point", "Deuxième point"] },
  {
    type: "table",
    rows: [
      ["Nom", "Valeur"],
      ["Paris", "42"],
    ],
  },
];

const englishBlocks = [
  { type: "heading", text: "Introduction", level: 2 },
  {
    type: "paragraph",
    text: "This is an English paragraph with the Arabic word العربية.",
    bold: true,
    italic: true,
    align: "left",
  },
  { type: "bullets", items: ["First point", "Second point"] },
  {
    type: "table",
    rows: [
      ["Name", "Value"],
      ["London", "42"],
    ],
  },
];

try {
  tempClient = await startClient(tempDir, "wps-docs-mcp-create-temp");
  realClient = await startClient(REAL_DOCS_DIR, "wps-docs-mcp-create-real");

  const { text: arabicText } = await createAndRead(
    tempClient,
    {
      output: "arabic_test.docx",
      title: "تقرير تجريبي",
      rtl: true,
      language: "ar",
      blocks: arabicBlocks,
    },
    [
      "تقرير تجريبي",
      "مقدمة",
      "هذا نص عربي",
      "française",
      "النقطة الأولى",
      "Point en français",
      "أحمد",
      "١٢٣",
      "France",
    ],
    "Arabic"
  );
  const arabicChars = arabicText.match(/[\u0600-\u06FF]/g) ?? [];
  check("Arabic: real Arabic characters present", arabicChars.length > 0);
  check(
    "Arabic: French word is intact inside the Arabic paragraph",
    arabicText.includes("française")
  );

  const { text: frenchText } = await createAndRead(
    tempClient,
    {
      output: "french_test.docx",
      title: "Rapport de test",
      language: "fr",
      blocks: frenchBlocks,
    },
    [
      "Rapport de test",
      "Introduction",
      "Ceci est un paragraphe en français",
      "العربية",
      "Premier point",
      "Deuxième point",
      "Paris",
      "42",
    ],
    "French"
  );
  check("French: accented French text intact", frenchText.includes("français"));

  await createAndRead(
    tempClient,
    {
      output: "english_test.docx",
      title: "Test Report",
      language: "en",
      blocks: englishBlocks,
    },
    [
      "Test Report",
      "Introduction",
      "This is an English paragraph",
      "العربية",
      "First point",
      "Second point",
      "London",
      "42",
    ],
    "English"
  );

  // Formatting guarantees: black text, one page-number field per footer, and no
  // page border (borders were deliberately left out).
  const englishPath = path.join(tempDir, "english_test.docx");
  const englishXml = await inspectDocx(englishPath);

  const nonBlackColors = englishXml.all.match(
    /<w:color w:val="(?!000000)[0-9A-Fa-f]{6}"/g
  );
  check(
    "English: every text color is black",
    nonBlackColors === null,
    `found: ${nonBlackColors?.join(", ")}`
  );
  check(
    "English: footer contains a PAGE field",
    /<w:instrText[^>]*>\s*PAGE\s*<\/w:instrText>/.test(englishXml.footers),
    englishXml.footers
  );
  check(
    "English: footer has exactly one page-number field",
    (englishXml.footers.match(/PAGE/g) ?? []).length === 1,
    englishXml.footers
  );
  check(
    "English: no page border",
    !englishXml.document.includes("pgBorders"),
    "document.xml contains pgBorders"
  );

  // One persistent Arabic sample in the real DOCS_DIR (never deleted).
  // Only create it when the exact name is free; otherwise skip.
  const samplePath = path.join(REAL_DOCS_DIR, "sample_arabic.docx");
  const sampleExists = await fs
    .stat(samplePath)
    .then(() => true)
    .catch(() => false);

  if (sampleExists) {
    console.log("persistent sample already exists, skipped");
  } else {
    await createAndRead(
      realClient,
      {
        output: "sample_arabic.docx",
        title: "وثيقة عربية تجريبية",
        rtl: true,
        language: "ar",
        blocks: arabicBlocks,
      },
      [
        "وثيقة عربية تجريبية",
        "مقدمة",
        "هذا نص عربي",
        "française",
        "النقطة الأولى",
        "Point en français",
        "أحمد",
        "١٢٣",
        "France",
      ],
      "Arabic sample in real DOCS_DIR"
    );

    check(
      "real sample was created as sample_arabic.docx",
      Boolean(await fs.stat(samplePath).catch(() => null))
    );
    console.log(`\nPersistent sample path: ${samplePath}`);
  }
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
