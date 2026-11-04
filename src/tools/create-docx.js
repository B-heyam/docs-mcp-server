import path from "node:path";

import {
  AlignmentType,
  Document,
  Footer,
  HeadingLevel,
  LevelFormat,
  Packer,
  PageNumber,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
  convertInchesToTwip,
} from "docx";
import { z } from "zod";

import { errorResult } from "../lib/errors.js";
import { writeNewFile } from "../lib/files.js";
import { resolveSafe } from "../paths.js";

const CREATE_DOCX_ALIGNMENTS = {
  left: AlignmentType.LEFT,
  right: AlignmentType.RIGHT,
  center: AlignmentType.CENTER,
  justify: AlignmentType.JUSTIFIED,
};

const CREATE_DOCX_HEADINGS = {
  1: HeadingLevel.HEADING_1,
  2: HeadingLevel.HEADING_2,
  3: HeadingLevel.HEADING_3,
};

const CREATE_DOCX_LANGUAGE_TAGS = {
  ar: "ar-SA",
  fr: "fr-FR",
  en: "en-US",
};

const CREATE_DOCX_DEFAULT_FONTS = {
  rtl: "Arial",
  ltr: "Calibri",
};

// docx sizes are half-points: 24 = 12pt.
const CREATE_DOCX_BODY_SIZE = 24;

// Footer text is slightly smaller than the body.
const CREATE_DOCX_FOOTER_SIZE = 20;

// Every piece of text is pure black; the library defaults to blue headings.
const CREATE_DOCX_TEXT_COLOR = "000000";

// Built-in heading sizes (half-points) that the docx defaults would otherwise
// supply together with their blue color.
const CREATE_DOCX_HEADING_SIZES = { 1: 32, 2: 26, 3: 24 };

const headingStyles = {
  ...Object.fromEntries(
    Object.entries(CREATE_DOCX_HEADING_SIZES).map(([level, size]) => [
      `heading${level}`,
      { run: { color: CREATE_DOCX_TEXT_COLOR, size, sizeComplexScript: size } },
    ])
  ),
  // Levels 4-6 are not reachable through the tool's schema, but they ship in the
  // default stylesheet with blue text, so they are neutralized too.
  heading4: { run: { color: CREATE_DOCX_TEXT_COLOR, italics: true } },
  heading5: { run: { color: CREATE_DOCX_TEXT_COLOR } },
  heading6: { run: { color: CREATE_DOCX_TEXT_COLOR } },
};

const createDocxBlockSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("heading"),
    text: z.string(),
    level: z.number().int().min(1).max(3),
  }),
  z.object({
    type: z.literal("paragraph"),
    text: z.string(),
    bold: z.boolean().optional(),
    italic: z.boolean().optional(),
    align: z.enum(["left", "right", "center", "justify"]).optional(),
  }),
  z.object({
    type: z.literal("bullets"),
    items: z.array(z.string()),
  }),
  z.object({
    type: z.literal("table"),
    rows: z.array(z.array(z.string())),
  }),
]);

export function registerCreateDocxTools(server) {
  server.registerTool(
    "create_docx",
    {
      title: "Create DOCX",
      description:
        "Create a new .docx from headings, paragraphs, bullet lists and tables. Text is always black and every page gets a centered page number in the footer. Supports Arabic/RTL layout with right alignment, bidirectional paragraphs, RTL runs and RTL tables.",
      inputSchema: {
        output: z.string().min(1).describe("New .docx path relative to DOCS_DIR"),
        title: z.string().optional().describe("Optional document title (rendered as Heading 1)"),
        rtl: z.boolean().optional().describe("Right-to-left layout (implied by language ar)"),
        language: z.enum(["ar", "fr", "en"]).optional().describe("Document language"),
        blocks: z.array(createDocxBlockSchema).describe("Document blocks in order"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ output, title, rtl, language, blocks }) => {
      try {
        const outputPath = resolveSafe(output);

        if (path.extname(output).toLowerCase() !== ".docx") {
          throw new Error(`Output must end with .docx, got "${output}".`);
        }

        const effectiveLanguage = language ?? (rtl === true ? "ar" : "en");
        const isRtl = rtl === true || effectiveLanguage === "ar";
        const font = isRtl ? CREATE_DOCX_DEFAULT_FONTS.rtl : CREATE_DOCX_DEFAULT_FONTS.ltr;
        const languageTag = CREATE_DOCX_LANGUAGE_TAGS[effectiveLanguage];
        const defaultAlignment = isRtl ? AlignmentType.RIGHT : AlignmentType.LEFT;
        const languageOptions = {
          value: languageTag,
          ...(isRtl ? { bidirectional: "ar-SA" } : {}),
        };

        // docx 9.15.0 exposes size (Latin) and sizeComplexScript (Cs), both in
        // half-points. Headings omit these so their built-in larger sizes apply.
        const makeRun = (text, { bold = false, italic = false, size } = {}) =>
          new TextRun({
            text: String(text),
            font,
            rightToLeft: isRtl,
            bold: bold || undefined,
            italics: italic || undefined,
            language: languageOptions,
            ...(size !== undefined
              ? { size, sizeComplexScript: size }
              : {}),
          });

        const makeBodyRun = (text, options = {}) =>
          makeRun(text, { ...options, size: CREATE_DOCX_BODY_SIZE });

        const children = [];

        if (typeof title === "string" && title.trim() !== "") {
          children.push(
            new Paragraph({
              heading: HeadingLevel.HEADING_1,
              bidirectional: isRtl,
              alignment: defaultAlignment,
              children: [makeRun(title, { bold: true })],
            })
          );
        }

        for (const block of blocks) {
          if (block.type === "heading") {
            children.push(
              new Paragraph({
                heading: CREATE_DOCX_HEADINGS[block.level],
                bidirectional: isRtl,
                alignment: defaultAlignment,
                children: [makeRun(block.text)],
              })
            );
            continue;
          }

          if (block.type === "paragraph") {
            children.push(
              new Paragraph({
                bidirectional: isRtl,
                alignment: block.align
                  ? CREATE_DOCX_ALIGNMENTS[block.align]
                  : defaultAlignment,
                children: [
                  makeBodyRun(block.text, {
                    bold: block.bold,
                    italic: block.italic,
                  }),
                ],
              })
            );
            continue;
          }

          if (block.type === "bullets") {
            for (const item of block.items) {
              children.push(
                new Paragraph({
                  bidirectional: isRtl,
                  alignment: defaultAlignment,
                  ...(isRtl
                    ? { numbering: { reference: "rtl-bullets", level: 0 } }
                    : { bullet: { level: 0 } }),
                  children: [makeBodyRun(item)],
                })
              );
            }
            continue;
          }

          // block.type === "table"
          const rows = block.rows.map(
            (row) =>
              new TableRow({
                children: row.map(
                  (cell) =>
                    new TableCell({
                      children: [
                        new Paragraph({
                          bidirectional: isRtl,
                          alignment: defaultAlignment,
                          children: [makeBodyRun(cell)],
                        }),
                      ],
                    })
                ),
              })
          );

          children.push(
            new Table({
              rows,
              width: { size: 100, type: WidthType.PERCENTAGE },
              visuallyRightToLeft: isRtl,
            })
          );
        }

        const footer = new Footer({
          children: [
            new Paragraph({
              alignment: AlignmentType.CENTER,
              children: [
                new TextRun({
                  children: [PageNumber.CURRENT],
                  font,
                  color: CREATE_DOCX_TEXT_COLOR,
                  size: CREATE_DOCX_FOOTER_SIZE,
                  sizeComplexScript: CREATE_DOCX_FOOTER_SIZE,
                }),
              ],
            }),
          ],
        });

        const document = new Document({
          title: title ?? "Document",
          creator: "wps-docs-mcp",
          ...(isRtl
            ? {
                numbering: {
                  config: [
                    {
                      reference: "rtl-bullets",
                      levels: [
                        {
                          level: 0,
                          format: LevelFormat.BULLET,
                          text: "•",
                          alignment: AlignmentType.RIGHT,
                          style: {
                            paragraph: {
                              indent: {
                                right: convertInchesToTwip(0.5),
                                hanging: convertInchesToTwip(0.25),
                              },
                            },
                            run: { font, rightToLeft: true },
                          },
                        },
                      ],
                    },
                  ],
                },
              }
            : {}),
          styles: {
            default: {
              document: {
                run: {
                  font,
                  rightToLeft: isRtl,
                  language: languageOptions,
                  color: CREATE_DOCX_TEXT_COLOR,
                  size: CREATE_DOCX_BODY_SIZE,
                  sizeComplexScript: CREATE_DOCX_BODY_SIZE,
                },
                paragraph: { alignment: defaultAlignment },
              },
              ...headingStyles,
              hyperlink: { run: { color: CREATE_DOCX_TEXT_COLOR } },
              caption: { run: { color: CREATE_DOCX_TEXT_COLOR } },
            },
          },
          sections: [{ children, footers: { default: footer } }],
        });

        const buffer = await Packer.toBuffer(document);
        const writtenPath = await writeNewFile(outputPath, buffer);

        return {
          content: [{ type: "text", text: `Output file: ${writtenPath}` }],
        };
      } catch (error) {
        return errorResult(`create_docx failed: ${error.message}`);
      }
    }
  );
}
