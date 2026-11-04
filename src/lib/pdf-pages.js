export function formatPdfPage(items) {
  return items
    .filter((item) => typeof item.str === "string")
    .map((item) => item.str + (item.hasEOL ? "\n" : ""))
    .join("")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function parsePageRange(pages, numPages) {
  if (pages === undefined) {
    return { first: 1, last: numPages };
  }

  const value = pages.trim();
  const match = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(value);

  if (!match) {
    throw new Error(
      `Invalid pages value "${pages}". Use a page or range like "3" or "1-3".`
    );
  }

  const first = Number(match[1]);
  const last = match[2] === undefined ? first : Number(match[2]);

  if (first < 1 || last < first) {
    throw new Error(
      `Invalid pages value "${pages}". Page numbers start at 1 and the start must not exceed the end.`
    );
  }

  if (last > numPages) {
    throw new Error(
      `Page range "${pages}" is outside the document: it has ${numPages} page(s).`
    );
  }

  return { first, last };
}

/**
 * Parses a page selection like "1-3,5,8-10" into zero-based page indices,
 * keeping the order (and any duplicates) the caller wrote.
 */
export function parsePageList(spec, pageCount) {
  const value = spec.trim();

  if (value === "") {
    throw new Error("Invalid pages value: it must not be empty.");
  }

  const indices = [];

  for (const rawPart of value.split(",")) {
    const part = rawPart.trim();

    if (part === "") {
      throw new Error(`Invalid pages value "${spec}": it contains an empty entry.`);
    }

    const match = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(part);
    if (!match) {
      throw new Error(
        `Invalid pages value "${spec}": "${part}" is not a page or a range like "3" or "1-3".`
      );
    }

    const first = Number(match[1]);
    const last = match[2] === undefined ? first : Number(match[2]);

    if (first < 1 || last < 1) {
      throw new Error(
        `Invalid pages value "${spec}": page numbers start at 1, so 0 is not allowed.`
      );
    }

    if (last < first) {
      throw new Error(
        `Invalid range "${part}": the start page (${first}) is greater than the end page (${last}).`
      );
    }

    if (last > pageCount) {
      throw new Error(
        `Page range "${part}" is outside the document: it has ${pageCount} page(s).`
      );
    }

    for (let page = first; page <= last; page += 1) {
      indices.push(page - 1);
    }
  }

  return indices;
}
