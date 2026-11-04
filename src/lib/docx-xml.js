const XML_ENTITY_MAP = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

export function decodeXmlText(text) {
  return text.replace(
    /&(#x[0-9a-fA-F]+|#\d+|lt|gt|amp|quot|apos);/g,
    (entity, body) => {
      if (body.startsWith("#")) {
        const isHex = body[1].toLowerCase() === "x";
        const code = parseInt(body.slice(isHex ? 2 : 1), isHex ? 16 : 10);
        try {
          return String.fromCodePoint(code);
        } catch {
          return entity;
        }
      }
      return XML_ENTITY_MAP[body] ?? entity;
    }
  );
}

export function escapeXmlText(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Word text is split across <w:t> nodes (often one per run) while formatting
// lives on the surrounding <w:r>. Group text nodes by paragraph (innermost
// paragraph wins), then match over the concatenated text of each paragraph.
const DOCX_XML_TOKEN =
  /<w:p(?=[\s>])[^>]*>|<\/w:p>|<w:t(?<tAttrs>(?:\s[^>]*)?)>(?<tText>[\s\S]*?)<\/w:t>/g;

export function replaceTextInPart(xml, find, replacement) {
  const paragraphStack = [];
  const paragraphs = [];

  DOCX_XML_TOKEN.lastIndex = 0;
  let token;
  while ((token = DOCX_XML_TOKEN.exec(xml)) !== null) {
    const raw = token[0];

    if (raw === "</w:p>") {
      paragraphStack.pop();
      continue;
    }

    if (raw.startsWith("<w:p") && !raw.startsWith("<w:t")) {
      const paragraph = { nodes: [] };
      paragraphs.push(paragraph);
      paragraphStack.push(paragraph);
      continue;
    }

    const paragraph = paragraphStack[paragraphStack.length - 1];
    if (!paragraph) continue; // Text outside a paragraph: leave untouched.

    paragraph.nodes.push({
      fullStart: token.index,
      fullEnd: token.index + raw.length,
      attrs: token.groups.tAttrs ?? "",
      text: decodeXmlText(token.groups.tText ?? ""),
    });
  }

  const edits = [];
  let count = 0;

  for (const paragraph of paragraphs) {
    const nodes = paragraph.nodes;
    if (nodes.length === 0) continue;

    const starts = [];
    let totalLength = 0;
    for (const node of nodes) {
      starts.push(totalLength);
      totalLength += node.text.length;
    }
    if (totalLength === 0) continue;

    const paragraphText = nodes.map((node) => node.text).join("");

    const matches = [];
    let searchFrom = 0;
    while (searchFrom <= paragraphText.length - find.length) {
      const index = paragraphText.indexOf(find, searchFrom);
      if (index === -1) break;
      matches.push(index);
      searchFrom = index + find.length;
    }
    if (matches.length === 0) continue;

    const newTexts = nodes.map((node) => node.text);

    const locateNode = (position) => {
      let low = 0;
      let high = nodes.length - 1;
      let best = 0;
      while (low <= high) {
        const middle = (low + high) >> 1;
        if (starts[middle] <= position) {
          best = middle;
          low = middle + 1;
        } else {
          high = middle - 1;
        }
      }
      return best;
    };

    // Apply from the end so earlier character offsets stay valid.
    for (let matchIndex = matches.length - 1; matchIndex >= 0; matchIndex -= 1) {
      const start = matches[matchIndex];
      const end = start + find.length;
      const startNode = locateNode(start);
      const endNode = locateNode(end - 1);
      const startOffset = start - starts[startNode];
      const endOffset = end - starts[endNode];

      if (startNode === endNode) {
        newTexts[startNode] =
          newTexts[startNode].slice(0, startOffset) +
          replacement +
          newTexts[startNode].slice(endOffset);
      } else {
        // Replacement keeps the first run's formatting (w:rPr stays untouched).
        newTexts[startNode] =
          newTexts[startNode].slice(0, startOffset) + replacement;
        for (let nodeIndex = startNode + 1; nodeIndex < endNode; nodeIndex += 1) {
          newTexts[nodeIndex] = "";
        }
        newTexts[endNode] = newTexts[endNode].slice(endOffset);
      }
      count += 1;
    }

    for (let nodeIndex = 0; nodeIndex < nodes.length; nodeIndex += 1) {
      const node = nodes[nodeIndex];
      if (newTexts[nodeIndex] === node.text) continue;

      let attrs = node.attrs;
      const needsPreserve = /^\s|\s$/.test(newTexts[nodeIndex]);
      if (needsPreserve && !/xml:space\s*=/.test(attrs)) {
        attrs += ' xml:space="preserve"';
      }

      edits.push({
        start: node.fullStart,
        end: node.fullEnd,
        value: `<w:t${attrs}>${escapeXmlText(newTexts[nodeIndex])}</w:t>`,
      });
    }
  }

  edits.sort((a, b) => b.start - a.start);
  let result = xml;
  for (const edit of edits) {
    result = result.slice(0, edit.start) + edit.value + result.slice(edit.end);
  }

  return { xml: result, count };
}
