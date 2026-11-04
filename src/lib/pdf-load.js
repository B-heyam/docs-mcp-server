import fs from "node:fs/promises";
import path from "node:path";

import { PDFDocument } from "pdf-lib";

import { resolveSafe } from "../paths.js";

/**
 * Loads a PDF with pdf-lib and turns encryption or parse failures into clear
 * messages. pdf-lib refuses encrypted files unless ignoreEncryption is set.
 */
export async function loadPdfDocument(filePath, label) {
  const bytes = await fs.readFile(filePath);

  try {
    return await PDFDocument.load(bytes);
  } catch (error) {
    const encrypted =
      error?.constructor?.name === "EncryptedPDFError" ||
      /is encrypted/i.test(error?.message ?? "");

    if (encrypted) {
      throw new Error(`"${label}" is encrypted and cannot be read.`);
    }

    throw new Error(`"${label}" is not a readable PDF: ${error.message}`);
  }
}

export function resolvePdfOutput(output) {
  const outputPath = resolveSafe(output);

  if (path.extname(output).toLowerCase() !== ".pdf") {
    throw new Error(`Output must end with .pdf, got "${output}".`);
  }

  return outputPath;
}

export function pdfResult(writtenPath, pageCount) {
  return {
    content: [
      {
        type: "text",
        text: `Output file: ${writtenPath}\nPage count: ${pageCount}`,
      },
    ],
  };
}
