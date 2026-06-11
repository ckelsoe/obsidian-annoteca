import { countThreads, indicatorLabel, offsetOfLine } from "../reading-view";
import { parseAll } from "../parser";

const NOTE = [
	"# Title",
	"",
	"First paragraph. <!-- annoteca/clarify: which products? -->",
	"",
	"Second paragraph.",
	"<!-- annoteca/tone: flat",
	"[reply ai 2026-06-01]: suggestion",
	"[resolved charles 2026-06-02]: fixed",
	"-->",
].join("\n");

describe("countThreads", () => {
	it("counts open and resolved threads separately", () => {
		const counts = countThreads(parseAll(NOTE));
		expect(counts).toEqual({ open: 1, resolved: 1 });
	});

	it("counts threads, not replies", () => {
		const single = parseAll(NOTE).filter((c) => c.category === "tone");
		// One comment with one reply is one resolved thread.
		expect(single).toHaveLength(1);
		expect(countThreads(single)).toEqual({ open: 0, resolved: 1 });
	});

	it("is zero for no comments", () => {
		expect(countThreads([])).toEqual({ open: 0, resolved: 0 });
	});
});

describe("indicatorLabel", () => {
	it("shows only open when nothing is resolved", () => {
		expect(indicatorLabel({ open: 3, resolved: 0 })).toBe("3 open");
	});

	it("shows only resolved when nothing is open", () => {
		expect(indicatorLabel({ open: 0, resolved: 2 })).toBe("2 resolved");
	});

	it("joins both counts", () => {
		expect(indicatorLabel({ open: 1, resolved: 2 })).toBe("1 open · 2 resolved");
	});
});

describe("offsetOfLine", () => {
	it("returns 0 for the first line", () => {
		expect(offsetOfLine("a\nb\nc", 0)).toBe(0);
	});

	it("returns the offset after the newline", () => {
		expect(offsetOfLine("a\nb\nc", 1)).toBe(2);
		expect(offsetOfLine("a\nb\nc", 2)).toBe(4);
	});

	it("clamps past-the-end lines to content length", () => {
		expect(offsetOfLine("a\nb", 5)).toBe(3);
	});

	it("slices section comments by char range like the postprocessor does", () => {
		// Section = lines 4-8 (the second paragraph and its multi-line marker).
		const start = offsetOfLine(NOTE, 4);
		const end = offsetOfLine(NOTE, 9);
		const inSection = parseAll(NOTE).filter(
			(c) => c.marker.start >= start && c.marker.start < end,
		);
		expect(inSection).toHaveLength(1);
		expect(inSection[0]?.category).toBe("tone");
	});
});
