import { parseAll, parseAt, serialize, generateId, todayISO, findMalformedMarkers } from "../parser";
import type { Comment } from "../types";

describe("parser: single-line markers", () => {
	it("parses a minimal single-line marker", () => {
		const text = `Prose. <!-- annoteca/clarify: which products? --> more prose.`;
		const comments = parseAll(text);
		expect(comments).toHaveLength(1);
		const c = comments[0];
		expect(c).toBeDefined();
		if (!c) return;
		expect(c.category).toBe("clarify");
		expect(c.body).toBe("which products?");
		expect(c.id).toBeUndefined();
		expect(c.date).toBeUndefined();
		expect(c.author).toBeUndefined();
		expect(c.replies).toEqual([]);
		expect(c.resolution).toBeUndefined();
	});

	it("parses multiple markers on one line and preserves offsets", () => {
		const text = `A <!-- annoteca/tone: x --> B <!-- annoteca/cut: y --> C`;
		const comments = parseAll(text);
		expect(comments).toHaveLength(2);
		const [first, second] = comments;
		expect(first).toBeDefined();
		expect(second).toBeDefined();
		if (!first || !second) return;
		expect(first.category).toBe("tone");
		expect(second.category).toBe("cut");
		expect(text.slice(first.marker.start, first.marker.end))
			.toBe(`<!-- annoteca/tone: x -->`);
		expect(text.slice(second.marker.start, second.marker.end))
			.toBe(`<!-- annoteca/cut: y -->`);
	});

	it("supports hyphenated category names", () => {
		const text = `<!-- annoteca/source-needed: cite -->`;
		const comments = parseAll(text);
		expect(comments).toHaveLength(1);
		expect(comments[0]?.category).toBe("source-needed");
	});
});

describe("parser: multi-line markers", () => {
	const fullMarker = `<!-- annoteca/tone: doesn't sound like me
[id=a3b9c2x7]
[date=2026-05-23]
[author=charles]
[reply ai 2026-05-23]: Consider "She knew, in her bones, what love felt like."
[reply charles 2026-05-24]: I like "in her bones." Trying it.
[resolved charles 2026-05-25]: rewrote the line
-->`;

	it("parses metadata, replies (chronological), and resolution", () => {
		const comments = parseAll(fullMarker);
		expect(comments).toHaveLength(1);
		const c = comments[0];
		expect(c).toBeDefined();
		if (!c) return;
		expect(c.category).toBe("tone");
		expect(c.body).toBe("doesn't sound like me");
		expect(c.id).toBe("a3b9c2x7");
		expect(c.date).toBe("2026-05-23");
		expect(c.author).toBe("charles");
		expect(c.replies).toHaveLength(2);
		expect(c.replies[0]).toEqual({
			author: "ai",
			date: "2026-05-23",
			body: `Consider "She knew, in her bones, what love felt like."`,
		});
		expect(c.replies[1]).toEqual({
			author: "charles",
			date: "2026-05-24",
			body: `I like "in her bones." Trying it.`,
		});
		expect(c.resolution).toEqual({
			author: "charles",
			date: "2026-05-25",
			note: "rewrote the line",
		});
	});

	it("treats bracket-looking body content as body when a non-structured line follows it", () => {
		const text = `<!-- annoteca/clarify: line one
[reply ai 2026-05-23]: this looks like a reply
but here is a non-structured line, which means everything above is body
-->`;
		const c = parseAll(text)[0];
		expect(c).toBeDefined();
		if (!c) return;
		expect(c.replies).toHaveLength(0);
		expect(c.body).toContain("but here is a non-structured line");
	});

	it("treats bracket-shaped trailing lines we don't recognize as structured (forward-compat)", () => {
		const text = `<!-- annoteca/tone: body here
[priority=high]
[date=2026-05-23]
-->`;
		const c = parseAll(text)[0];
		expect(c).toBeDefined();
		if (!c) return;
		expect(c.body).toBe("body here");
		expect(c.date).toBe("2026-05-23");
	});

	it("allows a bare resolution line with no note", () => {
		const text = `<!-- annoteca/tone: body
[resolved charles 2026-05-25]:
-->`;
		const c = parseAll(text)[0];
		expect(c).toBeDefined();
		if (!c) return;
		expect(c.resolution).toEqual({ author: "charles", date: "2026-05-25", note: "" });
	});
});

describe("parser: serialize", () => {
	it("emits the single-line form when there is no metadata", () => {
		const s = serialize({ category: "clarify", body: "which products?" });
		expect(s).toBe(`<!-- annoteca/clarify: which products? -->`);
	});

	it("emits the multi-line form when any metadata is present", () => {
		const s = serialize({
			category: "tone",
			body: "doesn't sound like me",
			id: "a3b9c2x7",
			date: "2026-05-23",
		});
		expect(s).toBe(
			[
				"<!-- annoteca/tone: doesn't sound like me",
				"[id=a3b9c2x7]",
				"[date=2026-05-23]",
				"-->",
			].join("\n"),
		);
	});

	it("emits the multi-line form when the body itself spans lines", () => {
		const s = serialize({ category: "tone", body: "line a\nline b" });
		expect(s).toBe(
			[
				"<!-- annoteca/tone: line a",
				"line b",
				"-->",
			].join("\n"),
		);
	});
});

describe("parser: round-trip property", () => {
	const cases: Comment[] = [
		{
			id: undefined, category: "tone", body: "short body",
			date: undefined, author: undefined,
			replies: [], resolution: undefined,
			marker: { start: 0, end: 0 },
		},
		{
			id: "a3b9c2x7", category: "tone", body: "doesn't sound like me",
			date: "2026-05-23", author: "charles",
			replies: [
				{ author: "ai", date: "2026-05-23", body: "consider X" },
				{ author: "charles", date: "2026-05-24", body: "trying it" },
			],
			resolution: undefined,
			marker: { start: 0, end: 0 },
		},
		{
			id: "z1z1z1z1", category: "source-needed", body: "needs citation",
			date: "2026-05-25", author: "ai",
			replies: [],
			resolution: { author: "charles", date: "2026-05-25", note: "added in revision pass" },
			marker: { start: 0, end: 0 },
		},
	];

	for (let i = 0; i < cases.length; i++) {
		const c = cases[i];
		if (!c) continue;
		it(`case ${i}: parse(serialize(c)) preserves the comment`, () => {
			const s = serialize({
				id: c.id, category: c.category, body: c.body,
				date: c.date, author: c.author,
				replies: c.replies,
				resolution: c.resolution,
			});
			const parsed = parseAll(s);
			expect(parsed).toHaveLength(1);
			const got = parsed[0];
			expect(got).toBeDefined();
			if (!got) return;
			expect(got.category).toBe(c.category);
			expect(got.body).toBe(c.body);
			expect(got.id).toBe(c.id);
			expect(got.date).toBe(c.date);
			expect(got.author).toBe(c.author);
			expect(got.replies).toEqual(c.replies);
			expect(got.resolution).toEqual(c.resolution);
		});
	}
});

describe("parser: parseAt", () => {
	it("returns the marker at a known offset", () => {
		const text = `prefix <!-- annoteca/tone: body --> suffix`;
		const start = text.indexOf("<!--");
		const c = parseAt(text, start);
		expect(c).toBeDefined();
		expect(c?.category).toBe("tone");
	});

	it("returns undefined when no marker starts at the given offset", () => {
		const text = `prefix <!-- annoteca/tone: body --> suffix`;
		expect(parseAt(text, 0)).toBeUndefined();
	});
});

describe("parser: generateId / todayISO", () => {
	it("generates an 8-character base36 id", () => {
		for (let i = 0; i < 64; i++) {
			const id = generateId();
			expect(id).toHaveLength(8);
			expect(id).toMatch(/^[a-z0-9]{8}$/);
		}
	});

	it("emits ISO YYYY-MM-DD for a known date", () => {
		expect(todayISO(new Date(2026, 4, 25))).toBe("2026-05-25");
	});
});

describe("parser: findMalformedMarkers", () => {
	it("returns nothing for well-formed markers", () => {
		const text = `<!-- annoteca/tone: x -->`;
		expect(findMalformedMarkers(text)).toEqual([]);
	});

	it("flags an unclosed marker shell", () => {
		const text = `<!-- annoteca/TONE: x --> end`;
		const flagged = findMalformedMarkers(text);
		expect(flagged.length).toBeGreaterThanOrEqual(1);
	});
});
