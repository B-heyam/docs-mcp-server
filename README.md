# wps-docs-mcp

A local MCP server for reading and editing documents in one workspace folder.
It is plain JavaScript (ES modules, no build step) and runs over stdio.

## Setup

1. Clone this repository and open its project folder.
2. Run `npm install`.
3. Copy `opencode.example.json` to `opencode.json`.
4. Edit the server script and documents folder paths in `opencode.json`.
5. Start OpenCode from the project folder and check the MCP connection with `/mcp`.

## Tools

| Tool | Description |
| --- | --- |
| `list_files` | Lists the `.pdf` and `.docx` files in `DOCS_DIR` with their size in KB. |
| `read_docx` | Extracts the raw text from a `.docx`, preserving Arabic and other UTF-8 text. |
| `read_pdf` | Extracts text page by page from a `.pdf`, optionally limited to a page range. |
| `replace_text_docx` | Replaces text in a `.docx` (body, headers, footers) and saves a new copy, keeping formatting. |
| `create_docx` | Creates a new `.docx` from headings, paragraphs, bullet lists and tables, with black text and a centered page number in the footer; optional RTL/Arabic layout. |
| `pdf_extract_pages` | Creates a new PDF containing only the selected pages, in the order given. |
| `merge_pdfs` | Merges two or more PDFs into a new PDF, in the given order. |
| `pdf_add_text` | Draws text onto existing PDF pages, including shaped Arabic and accented French. |

## Project structure

```text
src/
├── server.js
├── paths.js
├── lib/
│   ├── docx-xml.js
│   ├── errors.js
│   ├── files.js
│   ├── pdf-load.js
│   ├── pdf-pages.js
│   └── pdf-text.js
└── tools/
    ├── create-docx.js
    ├── list.js
    ├── pdf.js
    ├── read.js
    └── replace.js
test/
├── helpers.js
├── test-create.js
├── test-list.js
├── test-pdf.js
├── test-pdf-text.js
├── test-read.js
├── test-replace.js
└── manual/
    └── manual-replace.js
```

## DOCS_DIR

The server reads the workspace location from the `DOCS_DIR` environment variable.
It has no default: if `DOCS_DIR` is missing, the server exits with a clear error.
Every input and output path is resolved inside that folder.

PowerShell example:

```powershell
$env:DOCS_DIR = "C:\path\to\your\documents"
npm start
```

## Originals are never overwritten

Every tool that produces a file writes a **new** file. If the requested output
name already exists, a numbered suffix is added (`_2`, `_3`, ...). The source
document is never modified, even when the requested output points at it.

## Tests

All tests start the real MCP server over stdio and use `DOCS_DIR`:

```powershell
$env:DOCS_DIR = "C:\path\to\your\documents"
npm run test:list
npm run test:read
npm run test:replace
npm run test:create
npm run test:pdf
npm run test:pdf-text
npm run manual:replace
```

Tests use the `DOCS_DIR` environment variable and should point to a folder
containing at least one `.docx` and one `.pdf` file.

Tests that need a persistent sample (`sample_arabic.docx`, `merged_sample.pdf`,
`text_sample.pdf`) only create it when that exact name is free; otherwise they
print `persistent sample already exists, skipped`.

`manual:replace` is a manual integration test that writes a new output file into
`DOCS_DIR`; it is not part of the six automated test scripts.

## Known limits

- PDF text cannot be edited directly. The PDF tools only extract, merge, or draw
  new text on top of pages; existing page content is left as-is.
- `create_docx` always writes black text and a centered page number in the footer.
  It has no option for other colors or for a page border.
- `replace_text_docx` uses case-sensitive substring matching. `AI` does not match
  `ai`, and the match can span multiple Word runs but not paragraphs.
- Arabic in `pdf_add_text` is shaped with `arabic-reshaper` and reordered with
  `bidi-js`. The PDF stores presentation forms, so extracted text is joined
  Arabic (U+FE70-U+FEFF), not the original logical codepoints.
- Files in `DOCS_DIR` must be available on the device. Cloud-only synced
  placeholders must be downloaded first, or reads will fail.
- Office/WPS lock files (names starting with `~$`) are ignored by `list_files`.
