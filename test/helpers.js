import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const serverEntry = path.join(projectRoot, "src", "server.js");
export const REAL_DOCS_DIR =
  process.env.DOCS_DIR || path.join(os.homedir(), "Documents", "work");

export let failures = 0;

export function check(label, ok, detail = "") {
  if (ok) {
    console.log(`[PASS] ${label}`);
  } else {
    failures += 1;
    console.error(`[FAIL] ${label}${detail ? `: ${detail}` : ""}`);
  }
}

export function recordFailure() {
  failures += 1;
}

export function textOf(result) {
  return result.content?.find((item) => item.type === "text")?.text ?? "";
}

export function outputPathFrom(text) {
  return text
    .split(/\r?\n/)
    .find((line) => line.startsWith("Output file:"))
    ?.slice("Output file:".length)
    .trim();
}

export async function startClient(docsDir, name) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry],
    cwd: projectRoot,
    env: { ...process.env, DOCS_DIR: docsDir },
    stderr: "inherit",
  });

  const client = new Client({ name, version: "1.0.0" });
  await client.connect(transport);
  return client;
}

export async function closeClient(client, ignoreErrors = false) {
  if (!client) return;
  if (ignoreErrors) {
    await client.close().catch(() => {});
    return;
  }
  await client.close();
}

export function pageTexts(text, normalizeWhitespace = false) {
  const headers = [...text.matchAll(/--- Page (\d+) ---\n/g)];

  return headers.map((match, index) => {
    const start = match.index + match[0].length;
    const end = index + 1 < headers.length ? headers[index + 1].index : text.length;
    const pageText = text.slice(start, end).replace(/\n\n$/, "");
    return normalizeWhitespace ? pageText.replace(/\s+/g, " ").trim() : pageText;
  });
}

export async function readPdf(client, name, pages) {
  const result = await client.callTool({
    name: "read_pdf",
    arguments: pages === undefined ? { path: name } : { path: name, pages },
  });
  return { result, text: textOf(result) };
}

export async function listDocuments(directory, extension) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  return entries
    .filter(
      (entry) =>
        entry.isFile() &&
        !entry.name.startsWith("~$") &&
        (!extension || path.extname(entry.name).toLowerCase() === extension.toLowerCase())
    )
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
}
