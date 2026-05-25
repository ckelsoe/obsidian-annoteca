import { formatScripture } from "../scripture";

describe("formatScripture", () => {
	it("canonicalizes a simple reference with translation", () => {
		const r = formatScripture("see john 3:16 esv for context");
		expect(r.updated).toContain("John 3:16 (ESV)");
		expect(r.changes).toBeGreaterThan(0);
	});

	it("handles verse ranges", () => {
		const r = formatScripture("read romans 8:28-30 nlt today");
		expect(r.updated).toContain("Romans 8:28-30 (NLT)");
	});

	it("handles books with leading numbers", () => {
		const r = formatScripture("compare 1 john 3:16 with 1 corinthians 13:1 esv");
		expect(r.updated).toContain("1 John 3:16");
		expect(r.updated).toContain("1 Corinthians 13:1 (ESV)");
	});

	it("leaves unknown books untouched", () => {
		const r = formatScripture("widget 3:16 xyz");
		expect(r.updated).toBe("widget 3:16 xyz");
		expect(r.changes).toBe(0);
	});

	it("reformats the reference but keeps an unknown trailing word as plain prose", () => {
		const r = formatScripture("john 3:16 xyz");
		expect(r.updated).toBe("John 3:16 xyz");
	});

	it("rewrites without a translation when not provided", () => {
		const r = formatScripture("john 3:16 is famous");
		expect(r.updated).toContain("John 3:16");
		expect(r.updated).not.toContain("()");
	});
});
