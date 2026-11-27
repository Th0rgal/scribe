import { describe, expect, it } from "vitest";
import { applyMathEdit, extractMathSpans } from "./mathParser";
import { renderKatexSafe } from "./katexRender";

describe("Scribe offline KaTeX & mathParser", () => {
  it("extracts inline and display math spans", () => {
    const md = "Energy is $E = mc^2$ and\n\n$$\\int_0^1 x^2 dx = \\frac{1}{3}$$\n";
    const spans = extractMathSpans(md);
    expect(spans.length).toBe(2);
    expect(spans[0].display).toBe(false);
    expect(spans[0].tex).toBe("E = mc^2");
    expect(spans[1].display).toBe(true);
    expect(spans[1].tex).toContain("\\int_0^1");
  });

  it("applies lossless delimiter-preserving edits", () => {
    const md = "Value: $x + 1$ done";
    const spans = extractMathSpans(md);
    const updated = applyMathEdit(md, spans[0], "x + 2");
    expect(updated).toBe("Value: $x + 2$ done");
  });

  it("renders KaTeX safely offline", () => {
    const ok = renderKatexSafe("E = mc^2", false);
    expect(ok.error).toBeNull();
    expect(ok.html).toContain("katex");
  });
});
