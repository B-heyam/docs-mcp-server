import fs from "node:fs/promises";
import path from "node:path";

import JSZip from "jszip";
import { z } from "zod";

import { replaceTextInPart } from "../lib/docx-xml.js";
import { errorResult } from "../lib/errors.js";
import { resolveDocument, writeNewFile } from "../lib/files.js";
import { resolveSafe } from "../paths.js";

export function registerReplaceTools(server) {
  server.registerTool(
    "replace_text_docx",
    {
      title: "Replace text in DOCX",
      description:
        "Replace every occurrence of a text string in a .docx (including headers and footers) and save it as a new file. Never overwrites an existing file. Keeps formatting, RTL and Arabic text by editing the document XML directly.",
      inputSchema: {
        path: z.string().min(1).describe("Path to the source .docx, relative to DOCS_DIR"),
        find: z.string().min(1).describe("Text to find (matches across Word runs)"),
        replace: z.string().describe("Replacement text"),
        output: z
          .string()
          .optional()
          .describe(
            'Optional new .docx path relative to DOCS_DIR. Defaults to "<original>_edited.docx".'
          ),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ path: relativePath, find, replace, output }) => {
      try {
        const { filePath: sourcePath } = await resolveDocument(relativePath, ".docx");

        let outputPath;
        if (output !== undefined) {
          outputPath = resolveSafe(output);

          if (path.extname(output).toLowerCase() !== ".docx") {
            throw new Error(
              `Output must end with .docx, got "${output}".`
            );
          }

          if (
            path.resolve(outputPath).toLowerCase() ===
            path.resolve(sourcePath).toLowerCase()
          ) {
            throw new Error(
              "Refusing to overwrite the original file. Choose a different output name."
            );
          }
        } else {
          const parsed = path.parse(sourcePath);
          outputPath = path.join(parsed.dir, `${parsed.name}_edited.docx`);
        }

        const buffer = await fs.readFile(sourcePath);

        let zip;
        try {
          zip = await JSZip.loadAsync(buffer);
        } catch (error) {
          throw new Error(
            `"${relativePath}" is not a valid .docx (zip) file: ${error.message}`
          );
        }

        const partNames = Object.keys(zip.files).filter((name) =>
          /^word\/(document|header\d*|footer\d*)\.xml$/i.test(name)
        );

        if (!partNames.includes("word/document.xml")) {
          throw new Error(
            `"${relativePath}" is not a valid .docx: word/document.xml is missing.`
          );
        }

        let totalReplacements = 0;

        for (const partName of partNames) {
          const part = zip.file(partName);
          if (!part) continue;

          const xml = await part.async("string");
          const replaced = replaceTextInPart(xml, find, replace);

          if (replaced.count > 0) {
            zip.file(partName, replaced.xml);
            totalReplacements += replaced.count;
          }
        }

        if (totalReplacements === 0) {
          return {
            content: [
              {
                type: "text",
                text:
                  `Replacements: 0\n` +
                  `No occurrences of "${find}" were found in ${relativePath}. ` +
                  "No file was created.",
              },
            ],
          };
        }

        const outputBuffer = await zip.generateAsync({
          type: "nodebuffer",
          compression: "DEFLATE",
        });

        const writtenPath = await writeNewFile(outputPath, outputBuffer);

        return {
          content: [
            {
              type: "text",
              text:
                `Replacements: ${totalReplacements}\n` +
                `Output file: ${writtenPath}`,
            },
          ],
        };
      } catch (error) {
        return errorResult(`replace_text_docx failed: ${error.message}`);
      }
    }
  );
}
