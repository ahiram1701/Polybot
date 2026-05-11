import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("systemd installer", () => {
  it("installs a UI-only service without embedding secrets", async () => {
    const script = await readFile(join(process.cwd(), "scripts", "install-systemd.sh"), "utf8");

    expect(script).toContain("ExecStart=");
    expect(script).toContain("dist/src/ui/index.js --static");
    expect(script).toContain("EnvironmentFile=-");
    expect(script).toContain("Restart=always");
    expect(script).not.toContain("POLYMARKET_PRIVATE_KEY=");
    expect(script).not.toContain("TELEGRAM_BOT_TOKEN=");
  });
});
