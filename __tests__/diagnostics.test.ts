import { detectMarkerConflicts, detectOrphans, validateMarkers } from "../diagnostics";

describe("detectMarkerConflicts", () => {
	it("flags non-annoteca namespaced HTML comments", () => {
		const text = `Some text. <!-- annoteca/tone: ok -->
<!-- other-tool/foo: bar -->
<!-- third-party/baz: qux -->`;
		const findings = detectMarkerConflicts(text, "note.md");
		const prefixes = findings.map(f => f.prefix).sort();
		expect(prefixes).toEqual(["other-tool", "third-party"]);
	});

	it("does not flag annoteca itself", () => {
		const text = `<!-- annoteca/tone: ok -->`;
		expect(detectMarkerConflicts(text, "note.md")).toHaveLength(0);
	});
});

describe("detectOrphans", () => {
	it("identifies a comment alone on its line between two blank lines", () => {
		const text = `Paragraph one.

<!-- annoteca/tone: floating -->

Paragraph two.`;
		const orphans = detectOrphans(text, "note.md");
		expect(orphans).toHaveLength(1);
	});

	it("does not flag a comment attached to prose", () => {
		const text = `Paragraph one. <!-- annoteca/tone: ok -->\n\nParagraph two.`;
		expect(detectOrphans(text, "note.md")).toHaveLength(0);
	});

	it("does not flag a comment at end of paragraph", () => {
		const text = `Paragraph one.\n<!-- annoteca/tone: ok -->\nNext line of paragraph.`;
		expect(detectOrphans(text, "note.md")).toHaveLength(0);
	});

	it("does not flag an addressed comment even when it sits alone (F-272)", () => {
		// An addressed comment may legitimately sit on its own line between blanks
		// (the AI replaced the surrounding prose). That is an expected pending
		// state, not an accidental orphan.
		const text = [
			"Paragraph one.",
			"",
			"<!-- annoteca/clarify: tighten this",
			"[id=addr0001]",
			"[addressed claude 2026-06-20]: replaced the passage",
			"```annoteca-original",
			"the old passage",
			"```",
			"-->",
			"",
			"Paragraph two.",
		].join("\n");
		expect(detectOrphans(text, "note.md")).toHaveLength(0);
	});
});

describe("validateMarkers", () => {
	it("reports malformed marker openings", () => {
		const text = `<!-- annoteca/TONE: bad uppercase -->`;
		const findings = validateMarkers(text, "note.md");
		expect(findings.length).toBeGreaterThan(0);
	});

	it("returns empty for clean content", () => {
		const text = `<!-- annoteca/tone: body --> and <!-- annoteca/cut: body -->`;
		expect(validateMarkers(text, "note.md")).toEqual([]);
	});
});
