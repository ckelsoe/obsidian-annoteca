import { getTemplate, composeScriptureReference, MODAL_TEMPLATES } from "../templates";

describe("templates: verse-needed", () => {
	it("returns a template", () => {
		expect(getTemplate("verse-needed")).toBeDefined();
	});

	it("composes a scripture reference", () => {
		expect(composeScriptureReference({
			book: "john",
			chapter: "3",
			verse: "16",
			translation: "esv",
		})).toBe("John 3:16 (ESV)");
	});

	it("returns empty when fields are missing", () => {
		expect(composeScriptureReference({ book: "john" })).toBe("");
	});
});

describe("templates: source-needed", () => {
	it("composes a structured body", () => {
		const t = MODAL_TEMPLATES["source-needed"];
		expect(t).toBeDefined();
		if (!t) return;
		const composed = t.compose(
			{ citationFormat: "APA", claim: "Most studies show X" },
			"need to verify",
		);
		expect(composed).toContain("APA");
		expect(composed).toContain("Most studies show X");
		expect(composed).toContain("need to verify");
	});
});

describe("templates: index-entry", () => {
	it("composes term plus subterm", () => {
		const t = MODAL_TEMPLATES["index-entry"];
		expect(t).toBeDefined();
		if (!t) return;
		const composed = t.compose(
			{ term: "Augustine", subterm: "doctrine of grace" },
			"see page 42",
		);
		expect(composed).toContain("Augustine > doctrine of grace");
	});
});
