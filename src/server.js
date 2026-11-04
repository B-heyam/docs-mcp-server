import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { getDocsDir } from "./paths.js";
import { registerCreateDocxTools } from "./tools/create-docx.js";
import { registerListTools } from "./tools/list.js";
import { registerPdfTools } from "./tools/pdf.js";
import { registerReplaceTools } from "./tools/replace.js";
import { registerReadTools } from "./tools/read.js";

const server = new McpServer({
  name: "wps-docs-mcp",
  version: "1.0.0",
});

registerListTools(server);
registerReadTools(server);
registerReplaceTools(server);
registerPdfTools(server);
registerCreateDocxTools(server);

async function main() {
  // Fail fast with a clear message before speaking the stdio protocol.
  const docsDir = getDocsDir();
  console.error(`[wps-docs-mcp] DOCS_DIR resolved to: ${docsDir}`);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[wps-docs-mcp] listening on stdio");
}

main().catch((error) => {
  console.error(`[wps-docs-mcp] fatal: ${error.message}`);
  process.exit(1);
});
