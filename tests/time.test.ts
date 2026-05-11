import { describe, expect, it } from "vitest";

import {
  getBtcUpDownSlugFromStartMs,
  getCurrentBtcUpDownSlug,
  getCurrentUpDownSlug,
  getUpDownSlugFromStartMs,
  getWindowEndMs,
  getWindowStartMs,
  getWindowStartMsFromSlug,
} from "../src/time.js";

describe("BTC 5m window helpers", () => {
  it("rounds timestamps down to the active five-minute window", () => {
    const insideWindow = Date.UTC(2026, 4, 7, 4, 27, 12, 345);
    const start = Date.UTC(2026, 4, 7, 4, 25, 0, 0);

    expect(getWindowStartMs(insideWindow)).toBe(start);
    expect(getWindowEndMs(insideWindow)).toBe(start + 5 * 60 * 1000);
  });

  it("builds and parses Polymarket BTC 5m slugs", () => {
    const start = Date.UTC(2026, 4, 7, 4, 25, 0, 0);
    const slug = "btc-updown-5m-1778127900";

    expect(getBtcUpDownSlugFromStartMs(start)).toBe(slug);
    expect(getCurrentBtcUpDownSlug(start + 42_000)).toBe(slug);
    expect(getWindowStartMsFromSlug(slug)).toBe(start);
  });

  it("builds DOGE and ETH 5m slugs with Polymarket prefixes", () => {
    const start = Date.UTC(2026, 4, 7, 4, 25, 0, 0);

    expect(getUpDownSlugFromStartMs("DOGE", start)).toBe("doge-updown-5m-1778127900");
    expect(getUpDownSlugFromStartMs("ETH", start)).toBe("eth-updown-5m-1778127900");
    expect(getCurrentUpDownSlug("DOGE", start + 42_000)).toBe("doge-updown-5m-1778127900");
    expect(getWindowStartMsFromSlug("eth-updown-5m-1778127900")).toBe(start);
  });
});
