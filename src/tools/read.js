import fs from "node:fs/promises";

import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import mammoth from "mammoth";
import { z } from "zod";

import { errorResult } from "../lib/errors.js";
import { resolveDocument } from "../lib/files.js";
import { formatPdfPage, parsePageRange } from "../lib/pdf-pages.js";

export function registerReadTools(server) {
  server.registerTool(
    "read_docx",
    {
      title: "Read DOCX text",
      description:
        "Extract the raw text from a .docx file inside DOCS_DIR. Arabic and other UTF-8 text are preserved.",
      inputSchema: {
        path: z.string().min(1).describe("Path to a .docx file, relative to DOCS_DIR"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ path: relativePath }) => {
      try {
        const { filePath } = await resolveDocument(relativePath, ".docx");
        const result = await mammoth.extractRawText({ path: filePath });
        const text = result.value;

        if (!text.trim()) {
          return {
            content: [
              {
                type: "text",
                text: `No extractable text found in ${relativePath}.`,
              },
            ],
          };
        }

        return {
          content: [{ type: "text", text }],
        };
      } catch (error) {
        return errorResult(`read_docx failed: ${error.message}`);
      }
    }
  );

  server.registerTool(
    "read_pdf",
    {
      title: "Read PDF text",
      description:
        'Extract text page by page from a .pdf file inside DOCS_DIR. Optionally pass pages like "1-3" (default: all pages).',
      inputSchema: {
        path: z.string().min(1).describe("Path to a .pdf file, relative to DOCS_DIR"),
        pages: z
          .string()
          .optional()
          .describe('Optional page or range, e.g. "2" or "1-3". Defaults to all pages.'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ path: relativePath, pages }) => {
      let loadingTask;

      try {
        const { filePath } = await resolveDocument(relativePath, ".pdf");
        const data = new Uint8Array(await fs.readFile(filePath));

        loadingTask = getDocument({ data, verbosity: 0 });
        const doc = await loadingTask.promise;
        const { first, last } = parsePageRange(pages, doc.numPages);

        const sections = [];

        for (let pageNumber = first; pageNumber <= last; pageNumber += 1) {
          const page = await doc.getPage(pageNumber);
          const content = await page.getTextContent();
          const text = formatPdfPage(content.items);

          sections.push(
            `--- Page ${pageNumber} ---\n${
              text || "[No extractable text on this page — it may be a scanned image.]"
            }`
          );
        }

        return {
          content: [{ type: "text", text: sections.join("\n\n") }],
        };
      } catch (error) {
        if (error?.name === "PasswordException") {
          return errorResult(
            `read_pdf failed: "${relativePath}" is password-protected and cannot be read.`
          );
        }
        if (error?.name === "InvalidPDFException") {
          return errorResult(
            `read_pdf failed: "${relativePath}" is not a valid PDF file.`
          );
        }
        return errorResult(`read_pdf failed: ${error.message}`);
      } finally {
        if (loadingTask) {
          await loadingTask.destroy().catch(() => {});
        }
      }
    }
  );
}
