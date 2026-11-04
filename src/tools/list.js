import fs from "node:fs/promises";
import path from "node:path";

import { resolveSafe } from "../paths.js";
import { errorResult } from "../lib/errors.js";

const DOCUMENT_EXTENSIONS = new Set([".pdf", ".docx"]);

export function registerListTools(server) {
  server.registerTool(
    "list_files",
    {
      title: "List documents",
      description:
        "List .pdf and .docx files in the DOCS_DIR workspace with their size in KB.",
      annotations: { readOnlyHint: true },
    },
    async () => {
      try {
        // Every tool goes through resolveSafe, even though this one takes no input.
        const dir = resolveSafe(".");
        const entries = await fs.readdir(dir, { withFileTypes: true });

        const files = [];

        for (const entry of entries) {
          if (!entry.isFile()) continue;
          if (entry.name.startsWith("~$")) continue; // Office/WPS lock file

          const ext = path.extname(entry.name).toLowerCase();
          if (!DOCUMENT_EXTENSIONS.has(ext)) continue;

          const stats = await fs.stat(path.join(dir, entry.name));
          const sizeKB = Math.round((stats.size / 1024) * 10) / 10;

          files.push({ name: entry.name, sizeKB });
        }

        files.sort((a, b) => a.name.localeCompare(b.name));

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ directory: dir, files }, null, 2),
            },
          ],
        };
      } catch (error) {
        return errorResult(`list_files failed: ${error.message}`);
      }
    }
  );
}
