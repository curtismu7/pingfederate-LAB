// The vendored shared/floating-dialog files match floating-dialog.sha256, which names the AI-DEMO-Standalone commit they came from.
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

describe("vendored floating-dialog", () => {
  it("matches floating-dialog.sha256 byte for byte, and the pin names the parent commit", () => {
    const dir = path.join(process.cwd(), "src", "floating-dialog");
    const text = fs.readFileSync(path.join(dir, "floating-dialog.sha256"), "utf8");
    expect(text.split("\n")[0]).toMatch(/^# vendored byte for byte from curtismu7\/AI-DEMO-Standalone shared\/floating-dialog at [0-9a-f]{7,40}/);
    const pins = text.split("\n").filter((l) => l && !l.startsWith("#")).map((l) => l.split(/\s+/));
    const files = ["FloatingDialog.jsx", "floating-dialog.css", "floating-dialog.test.jsx", "geometry.js", "useFloatingPanel.js"];
    expect(pins.map(([, f]) => f).sort()).toEqual([...files].sort());
    expect(fs.readdirSync(dir).filter((f) => f !== "floating-dialog.sha256").sort()).toEqual([...files].sort());
    for (const [h, f] of pins) expect(createHash("sha256").update(fs.readFileSync(path.join(dir, f))).digest("hex"), f).toBe(h);
  });
});
