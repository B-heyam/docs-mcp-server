import path from "node:path";

import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { z } from "zod";

import { errorResult } from "../lib/errors.js";
import { resolveDocument, writeNewFile } from "../lib/files.js";
import { parsePageList } from "../lib/pdf-pages.js";
import {
  loadPdfDocument,
  pdfResult,
  resolvePdfOutput,
} from "../lib/pdf-load.js";
import {
  ARABIC_TEXT_PATTERN,
  assertTtfCanDraw,
  canHelveticaDraw,
  loadWindowsArabicFont,
  parseHexColor,
  shapePdfText,
} from "../lib/pdf-text.js";

const pdfTextItemSchema = z.object({
  page: z.number().int().describe("1-based page number"),
  text: z.string().describe("Text to draw"),
  x: z
    .number()
    .describe("X in PDF points from the left edge (right edge when rtl is true)"),
  y: z.number().describe("Y in PDF points from the bottom edge"),
  size: z.number().positive().optional().describe("Font size in points (default 12)"),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional()
    .describe('Fill color as "#RRGGBB" (default black)'),
  rtl: z
    .boolean()
    .optional()
    .describe("Right-align at x and reorder mixed right-to-left text"),
  font: z
    .enum(["latin", "arabic"])
    .optional()
    .describe(
      '"latin" uses Helvetica; "arabic" uses a Windows TTF embedded with fontkit'
    ),
});

export function registerPdfTools(server) {
  server.registerTool(
    "pdf_extract_pages",
    {
      title: "Extract PDF pages",
      description:
        'Create a new .pdf containing only the selected pages of a PDF, in the order given (e.g. "1-3,5,8-10"). Never overwrites an existing file.',
      inputSchema: {
        path: z.string().min(1).describe("Source .pdf path, relative to DOCS_DIR"),
        pages: z
          .string()
          .min(1)
          .describe('Pages to keep, e.g. "1-3,5,8-10" (1-based, in output order)'),
        output: z
          .string()
          .optional()
          .describe(
            'Optional new .pdf path relative to DOCS_DIR. Defaults to "<original>_pages.pdf".'
          ),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ path: relativePath, pages, output }) => {
      try {
        const { filePath: sourcePath } = await resolveDocument(relativePath, ".pdf");

        const outputPath =
          output === undefined
            ? path.join(
                path.dirname(sourcePath),
                `${path.parse(sourcePath).name}_pages.pdf`
              )
            : resolvePdfOutput(output);

        const sourceDoc = await loadPdfDocument(sourcePath, relativePath);
        const indices = parsePageList(pages, sourceDoc.getPageCount());

        const outputDoc = await PDFDocument.create();
        const copiedPages = await outputDoc.copyPages(sourceDoc, indices);
        for (const page of copiedPages) {
          outputDoc.addPage(page);
        }

        const bytes = await outputDoc.save();
        const writtenPath = await writeNewFile(outputPath, Buffer.from(bytes));

        return pdfResult(writtenPath, outputDoc.getPageCount());
      } catch (error) {
        return errorResult(`pdf_extract_pages failed: ${error.message}`);
      }
    }
  );

  server.registerTool(
    "merge_pdfs",
    {
      title: "Merge PDFs",
      description:
        "Merge two or more .pdf files into a new .pdf, in the given order. Never overwrites an existing file.",
      inputSchema: {
        paths: z
          .array(z.string().min(1))
          .min(2)
          .describe("Two or more .pdf paths, relative to DOCS_DIR, in merge order"),
        output: z.string().min(1).describe("New .pdf path relative to DOCS_DIR"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ paths, output }) => {
      try {
        if (paths.length < 2) {
          throw new Error("At least two PDF paths are required to merge.");
        }

        const outputPath = resolvePdfOutput(output);
        const sources = [];

        for (const relativePath of paths) {
          const { filePath } = await resolveDocument(relativePath, ".pdf");
          const doc = await loadPdfDocument(filePath, relativePath);
          sources.push({ relativePath, doc });
        }

        const outputDoc = await PDFDocument.create();

        for (const { relativePath, doc } of sources) {
          const indices = doc.getPageIndices();
          const copiedPages = await outputDoc.copyPages(doc, indices);
          for (const page of copiedPages) {
            outputDoc.addPage(page);
          }

          if (doc.getPageCount() === 0) {
            throw new Error(`"${relativePath}" has no pages to merge.`);
          }
        }

        const bytes = await outputDoc.save();
        const writtenPath = await writeNewFile(outputPath, Buffer.from(bytes));

        return pdfResult(writtenPath, outputDoc.getPageCount());
      } catch (error) {
        return errorResult(`merge_pdfs failed: ${error.message}`);
      }
    }
  );

  server.registerTool(
    "pdf_add_text",
    {
      title: "Add text to PDF",
      description:
        "Draw text onto existing PDF pages and save a new .pdf. Coordinates are PDF points from the bottom-left. Supports Arabic shaping/bidi with a Windows TTF and French accents. Never overwrites an existing file.",
      inputSchema: {
        path: z.string().min(1).describe("Source .pdf path, relative to DOCS_DIR"),
        output: z
          .string()
          .optional()
          .describe(
            'Optional new .pdf path relative to DOCS_DIR. Defaults to "<original>_text.pdf".'
          ),
        items: z.array(pdfTextItemSchema).describe("Text items to draw"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ path: relativePath, output, items }) => {
      try {
        const { filePath: sourcePath } = await resolveDocument(relativePath, ".pdf");

        const outputPath =
          output === undefined
            ? path.join(
                path.dirname(sourcePath),
                `${path.parse(sourcePath).name}_text.pdf`
              )
            : resolvePdfOutput(output);

        const pdfDoc = await loadPdfDocument(sourcePath, relativePath);
        const pageCount = pdfDoc.getPageCount();

        // Validate all page numbers before modifying anything.
        for (const [index, item] of items.entries()) {
          if (item.page < 1) {
            throw new Error(
              `Item ${index + 1}: page ${item.page} is invalid; page numbers start at 1.`
            );
          }
          if (item.page > pageCount) {
            throw new Error(
              `Item ${index + 1}: page ${item.page} is outside the document: it has ${pageCount} page(s).`
            );
          }
        }

        // Embed each font at most once per document.
        let latinFontPromise;
        let arabicFontPromise;

        const getLatinFont = () =>
          (latinFontPromise ??= pdfDoc.embedFont(StandardFonts.Helvetica));

        const getArabicFont = () =>
          (arabicFontPromise ??= (async () => {
            const found = await loadWindowsArabicFont();
            pdfDoc.registerFontkit(fontkit);
            const pdfFont = await pdfDoc.embedFont(found.bytes);
            const fkFont = fontkit.create(found.bytes);
            return { pdfFont, fkFont, name: found.name };
          })());

        for (const item of items) {
          const size = item.size ?? 12;
          const color = item.color ? parseHexColor(item.color) : rgb(0, 0, 0);
          const rtl = item.rtl === true;
          const drawText = shapePdfText(item.text, rtl);

          if (drawText === "") continue;

          const hasArabic = ARABIC_TEXT_PATTERN.test(item.text);
          let font;
          let fontName;
          let fkFont;

          if (item.font === "arabic" || rtl || hasArabic) {
            const arabic = await getArabicFont();
            font = arabic.pdfFont;
            fkFont = arabic.fkFont;
            fontName = arabic.name;
          } else {
            const helvetica = await getLatinFont();

            if (canHelveticaDraw(helvetica, drawText, size)) {
              font = helvetica;
              fontName = "Helvetica";
            } else {
              // Helvetica is WinAnsi-only: fall back to the embedded TTF.
              const arabic = await getArabicFont();
              font = arabic.pdfFont;
              fkFont = arabic.fkFont;
              fontName = arabic.name;
            }
          }

          if (fkFont) assertTtfCanDraw(fkFont, drawText, fontName);

          let drawX = item.x;
          if (rtl) {
            // x is the right edge for RTL items.
            drawX = item.x - font.widthOfTextAtSize(drawText, size);
          }

          const page = pdfDoc.getPage(item.page - 1);
          page.drawText(drawText, {
            x: drawX,
            y: item.y,
            size,
            font,
            color,
          });
        }

        const bytes = await pdfDoc.save();
        const writtenPath = await writeNewFile(outputPath, Buffer.from(bytes));

        return pdfResult(writtenPath, pageCount);
      } catch (error) {
        return errorResult(`pdf_add_text failed: ${error.message}`);
      }
    }
  );
}
