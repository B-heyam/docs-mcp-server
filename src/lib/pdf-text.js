import fs from "node:fs/promises";
import path from "node:path";

import { rgb } from "pdf-lib";
import ArabicReshaper from "arabic-reshaper";
import bidiFactory from "bidi-js";

const WINDOWS_ARABIC_FONT_CONFIG = {
  directory: path.join(process.env.WINDIR ?? "C:\\Windows", "Fonts"),
  candidates: ["arial.ttf", "tahoma.ttf"],
};

// pdf-lib cannot shape Arabic: letters must be joined (arabic-reshaper) and
// the runs reordered (bidi-js) before they are drawn.
const bidi = bidiFactory();

export const ARABIC_TEXT_PATTERN =
  /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;

/**
 * Reads the first Arabic-capable TTF found in C:\Windows\Fonts at runtime.
 * Font files are never copied into the project.
 */
export async function loadWindowsArabicFont() {
  const tried = [];

  for (const name of WINDOWS_ARABIC_FONT_CONFIG.candidates) {
    const filePath = path.join(WINDOWS_ARABIC_FONT_CONFIG.directory, name);
    tried.push(filePath);

    try {
      const bytes = await fs.readFile(filePath);
      return { name, filePath, bytes };
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw new Error(`Cannot read font "${filePath}": ${error.message}`);
      }
    }
  }

  throw new Error(
    `No Arabic-capable font found. Looked for ${tried.join(" and ")}. ` +
      "Install arial.ttf or tahoma.ttf in the Windows Fonts folder."
  );
}

/**
 * Joins Arabic letters and converts the logical order to visual order for a
 * single left-to-right draw call.
 */
export function shapePdfText(text, rtl) {
  const hasArabic = ARABIC_TEXT_PATTERN.test(text);
  if (!hasArabic && !rtl) return text;

  const shaped = hasArabic ? ArabicReshaper.convertArabic(text) : text;
  const levels = bidi.getEmbeddingLevels(shaped, "rtl");
  return bidi.getReorderedString(shaped, levels);
}

export function canHelveticaDraw(font, text, size) {
  try {
    font.widthOfTextAtSize(text, size);
    return true;
  } catch {
    return false;
  }
}

/** Throws if the embedded TTF has no glyph for any visible character. */
export function assertTtfCanDraw(fkFont, text, fontName) {
  for (const char of text) {
    const codePoint = char.codePointAt(0);
    if (codePoint <= 0x20 || codePoint === 0x7f) continue;

    if (!fkFont.hasGlyphForCodePoint(codePoint)) {
      const hex = codePoint.toString(16).toUpperCase().padStart(4, "0");
      throw new Error(
        `Cannot draw character "${char}" (U+${hex}) with ${fontName}: the font has no glyph for it.`
      );
    }
  }
}

export function parseHexColor(hex) {
  const value = hex.slice(1);
  return rgb(
    parseInt(value.slice(0, 2), 16) / 255,
    parseInt(value.slice(2, 4), 16) / 255,
    parseInt(value.slice(4, 6), 16) / 255
  );
}
