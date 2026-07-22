// Pure presentation helpers for the terminal UI: ANSI color, box-drawing, width-aware padding and a
// handful of number formatters. Everything here is side-effect free except the module-level color
// switch (so `--once`/piped output can render clean text without escape codes). Layout math must use
// `visibleLength`, never `String.length`, or the invisible escape codes throw padding and box borders
// off by several columns.

let colorEnabled = true;

export function setColorEnabled(value: boolean): void {
  colorEnabled = value;
}

export function isColorEnabled(): boolean {
  return colorEnabled;
}

function wrap(open: number, close: number): (text: string) => string {
  const prefix = `\x1b[${open}m`;
  const suffix = `\x1b[${close}m`;
  return (text: string) => (colorEnabled ? `${prefix}${text}${suffix}` : text);
}

export const bold = wrap(1, 22);
export const dim = wrap(2, 22);
export const italic = wrap(3, 23);
export const underline = wrap(4, 24);
export const inverse = wrap(7, 27);

export const red = wrap(31, 39);
export const green = wrap(32, 39);
export const yellow = wrap(33, 39);
export const blue = wrap(34, 39);
export const magenta = wrap(35, 39);
export const cyan = wrap(36, 39);
export const gray = wrap(90, 39);
export const white = wrap(97, 39);

/** Highlighted tab/label: black text on a cyan background. */
export const highlight = (text: string): string => (colorEnabled ? `\x1b[30;46m${text}\x1b[0m` : text);

const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}

/** Visible column count, ignoring escape codes. Assumes single-width glyphs (our content is ASCII +
 * box-drawing), which is all the layout relies on. */
export function visibleLength(text: string): number {
  return stripAnsi(text).length;
}

/** Pad the visible content to `width` on the right. Operates on the raw (possibly colored) string. */
export function padEnd(text: string, width: number): string {
  const pad = width - visibleLength(text);
  return pad > 0 ? text + " ".repeat(pad) : text;
}

export function padStart(text: string, width: number): string {
  const pad = width - visibleLength(text);
  return pad > 0 ? " ".repeat(pad) + text : text;
}

/** Truncate a PLAIN string to `width`, adding an ellipsis when it overflows. Apply color afterwards so
 * we never slice through an escape code. */
export function truncate(text: string, width: number): string {
  if (width <= 0) {
    return "";
  }
  if (text.length <= width) {
    return text;
  }
  if (width === 1) {
    return "…";
  }
  return `${text.slice(0, width - 1)}…`;
}

const BOX = {
  topLeft: "┌",
  topRight: "┐",
  bottomLeft: "└",
  bottomRight: "┘",
  horizontal: "─",
  vertical: "│",
} as const;

/** Draw a titled box `width` columns wide around already-formatted content lines. Content is padded
 * (or truncated) to the inner width so borders line up regardless of ANSI color inside. */
export function boxed(title: string, lines: string[], width: number): string[] {
  const inner = Math.max(2, width - 2);
  const titleText = title ? ` ${title} ` : "";
  const titleVisible = visibleLength(titleText);
  const fill = Math.max(0, inner - titleVisible);
  const top = `${BOX.topLeft}${bold(titleText)}${BOX.horizontal.repeat(fill)}${BOX.topRight}`;
  const bottom = `${BOX.bottomLeft}${BOX.horizontal.repeat(inner)}${BOX.bottomRight}`;
  const body = lines.map((line) => {
    const visible = visibleLength(line);
    const clipped = visible > inner ? truncateColored(line, inner) : padEnd(line, inner);
    return `${BOX.vertical}${clipped}${BOX.vertical}`;
  });
  return [top, ...body, bottom];
}

// Truncation that tolerates color: strip, cut, and let the caller's coloring be lost only past the cut.
// Good enough for our boxes (we rarely overflow), and never slices mid-escape.
function truncateColored(text: string, width: number): string {
  const plain = stripAnsi(text);
  return padEnd(truncate(plain, width), width);
}

// ---- number formatting -------------------------------------------------------------------------

export function fmtUsd(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) {
    return "—";
  }
  const sign = value < 0 ? "-" : "";
  return `${sign}$${Math.abs(value).toFixed(2)}`;
}

/** Signed dollars, e.g. "+$3.20" / "-$5.00" — for P&L where the sign carries meaning. */
export function fmtSignedUsd(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) {
    return "—";
  }
  const sign = value >= 0 ? "+" : "-";
  return `${sign}$${Math.abs(value).toFixed(2)}`;
}

export function fmtPct(value: number | undefined, digits = 1): string {
  if (value === undefined || !Number.isFinite(value)) {
    return "—";
  }
  return `${value.toFixed(digits)}%`;
}

export function fmtInt(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) {
    return "—";
  }
  return String(Math.round(value));
}

/** Color a P&L number green when ≥0, red when <0. Returns the formatted+colored string. */
export function colorSignedUsd(value: number | undefined): string {
  const text = fmtSignedUsd(value);
  if (value === undefined || !Number.isFinite(value)) {
    return dim(text);
  }
  return value >= 0 ? green(text) : red(text);
}
