import { parseAll, parseAt, serialize, generateId, todayISO, nowISO, findMalformedMarkers, buildAnchorFromSelection, ANCHOR_MAX_CHARS } from "../parser";
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

	it("preserves mixed-case and dotted authors in author, reply, and resolved lines", () => {
		const text = `<!-- annoteca/tone: body
[author=J.Doe]
[reply AI-Bot 2026-05-23]: a reply
[resolved Charles 2026-05-25]: done
-->`;
		const c = parseAll(text)[0];
		expect(c).toBeDefined();
		if (!c) return;
		expect(c.author).toBe("J.Doe");
		expect(c.replies[0]?.author).toBe("AI-Bot");
		expect(c.resolution).toEqual({ author: "Charles", date: "2026-05-25", note: "done" });
	});
});

describe("parser: anchor", () => {
	it("parses a tail [anchor=...] line into a Comment.anchor object", () => {
		const text = [
			`<!-- annoteca/clarify: which products?`,
			`[id=a3b9c2x7]`,
			`[anchor=quantitative targets such as reduced review time]`,
			`-->`,
		].join("\n");
		const [c] = parseAll(text);
		expect(c).toBeDefined();
		if (!c) return;
		expect(c.anchor).toBeDefined();
		expect(c.anchor?.text).toBe("quantitative targets such as reduced review time");
		expect(c.anchor?.truncated).toBe(false);
	});

	it("treats an anchor containing a U+2026 ellipsis as truncated", () => {
		const text = [
			`<!-- annoteca/clarify: x`,
			`[anchor=opening words…closing words]`,
			`-->`,
		].join("\n");
		const [c] = parseAll(text);
		expect(c?.anchor?.truncated).toBe(true);
	});

	it("round-trips a comment with an anchor through serialize and parseAll", () => {
		const s = serialize({
			category: "tone",
			body: "needs work",
			id: "a3b9c2x7",
			date: "2026-05-26",
			anchor: { text: "the cold morning air", truncated: false },
		});
		const [c] = parseAll(s);
		expect(c?.anchor).toEqual({ text: "the cold morning air", truncated: false });
	});

	it("emits no [anchor=...] line when the comment has no anchor", () => {
		const s = serialize({
			category: "tone",
			body: "needs work",
			id: "a3b9c2x7",
			date: "2026-05-26",
		});
		expect(s).not.toContain("[anchor=");
	});
});

describe("buildAnchorFromSelection", () => {
	it("returns undefined for empty or whitespace-only selections", () => {
		expect(buildAnchorFromSelection("")).toBeUndefined();
		expect(buildAnchorFromSelection("   \n\t")).toBeUndefined();
	});

	it("strips line breaks and `]` characters from the captured text", () => {
		const a = buildAnchorFromSelection("first line\nsecond ]line]");
		expect(a?.text).toBe("first line second line");
		expect(a?.truncated).toBe(false);
	});

	it("collapses internal whitespace to single spaces", () => {
		const a = buildAnchorFromSelection("a    b\t\tc");
		expect(a?.text).toBe("a b c");
	});

	it("returns the cleaned text untruncated when within the cap", () => {
		const a = buildAnchorFromSelection("short selection");
		expect(a?.truncated).toBe(false);
		expect(a?.text).toBe("short selection");
	});

	it("mid-truncates with a single U+2026 when over the cap", () => {
		const long = "x".repeat(60) + " middle " + "y".repeat(60);
		const a = buildAnchorFromSelection(long);
		expect(a?.truncated).toBe(true);
		expect(a?.text.includes("…")).toBe(true);
		// The stored value must not exceed the cap.
		expect(a?.text.length).toBeLessThanOrEqual(ANCHOR_MAX_CHARS);
		// Both ends are preserved.
		expect(a?.text.startsWith("x")).toBe(true);
		expect(a?.text.endsWith("y")).toBe(true);
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
			date: undefined, author: undefined, anchor: undefined,
			replies: [], addressed: undefined, resolution: undefined,
			marker: { start: 0, end: 0 },
		},
		{
			id: "a3b9c2x7", category: "tone", body: "doesn't sound like me",
			date: "2026-05-23", author: "charles", anchor: undefined,
			replies: [
				{ author: "ai", date: "2026-05-23", body: "consider X" },
				{ author: "charles", date: "2026-05-24", body: "trying it" },
			],
			addressed: undefined,
			resolution: undefined,
			marker: { start: 0, end: 0 },
		},
		{
			id: "z1z1z1z1", category: "source-needed", body: "needs citation",
			date: "2026-05-25", author: "ai", anchor: undefined,
			replies: [],
			addressed: undefined,
			resolution: { author: "charles", date: "2026-05-25", note: "added in revision pass" },
			marker: { start: 0, end: 0 },
		},
		{
			id: "anchor01", category: "clarify", body: "be specific",
			date: "2026-05-26", author: undefined,
			anchor: { text: "the cold morning air", truncated: false },
			replies: [], addressed: undefined, resolution: undefined,
			marker: { start: 0, end: 0 },
		},
		// F-270/F-271: addressed state with a single-line note and a multi-line
		// annoteca-original fence, plus a reply before it. Exercises ordering
		// (reply, addressed+fence) and lossless original round-trip.
		{
			id: "addr0001", category: "clarify", body: "tighten this",
			date: "2026-06-20", author: "charles",
			anchor: { text: "it landed as a shock", truncated: false },
			replies: [
				{ author: "charles", date: "2026-06-20", body: "go ahead" },
			],
			addressed: {
				author: "claude", date: "2026-06-20",
				note: "Cut the self-deprecating framing.",
				original: "So when I finally read it slowly,\nit landed as a shock.",
			},
			resolution: undefined,
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
				anchor: c.anchor,
				replies: c.replies,
				addressed: c.addressed,
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
			expect(got.anchor).toEqual(c.anchor);
			expect(got.replies).toEqual(c.replies);
			expect(got.addressed).toEqual(c.addressed);
			expect(got.resolution).toEqual(c.resolution);
		});
	}
});

describe("parser: addressed state (F-270/F-271)", () => {
	const addressedMarker = [
		"<!-- annoteca/clarify: tighten this",
		"[id=addr0001]",
		"[date=2026-06-20]",
		"[anchor=it landed as a shock]",
		"[reply charles 2026-06-20]: go ahead",
		"[addressed claude 2026-06-20]: Cut the framing.",
		"```annoteca-original",
		"So when I finally read it slowly,",
		"it landed as a shock.",
		"```",
		"-->",
	].join("\n");

	it("parses the [addressed ...] line and extracts the annoteca-original fence", () => {
		const c = parseAll(addressedMarker)[0];
		expect(c).toBeDefined();
		if (!c) return;
		expect(c.addressed).toBeDefined();
		expect(c.addressed?.author).toBe("claude");
		expect(c.addressed?.date).toBe("2026-06-20");
		expect(c.addressed?.note).toBe("Cut the framing.");
		expect(c.addressed?.original).toBe("So when I finally read it slowly,\nit landed as a shock.");
	});

	it("leaves the body clean (fence and addressed line are not body text)", () => {
		const c = parseAll(addressedMarker)[0];
		expect(c?.body).toBe("tighten this");
	});

	it("keeps the reply that precedes the addressed line", () => {
		const c = parseAll(addressedMarker)[0];
		expect(c?.replies).toEqual([{ author: "charles", date: "2026-06-20", body: "go ahead" }]);
	});

	it("still matches the canonical marker (greppable, full span through -->)", () => {
		const comments = parseAll(`prefix ${addressedMarker} suffix`);
		expect(comments).toHaveLength(1);
	});

	it("parses an addressed line with no fence (addressed without replacement)", () => {
		const text = [
			"<!-- annoteca/clarify: tighten this",
			"[id=addr0002]",
			"[addressed claude 2026-06-20]: tweaked in place",
			"-->",
		].join("\n");
		const c = parseAll(text)[0];
		expect(c?.addressed?.note).toBe("tweaked in place");
		expect(c?.addressed?.original).toBeUndefined();
	});

	it("treats a comment with no addressed line as open (addressed undefined)", () => {
		const text = "<!-- annoteca/clarify: which products? -->";
		expect(parseAll(text)[0]?.addressed).toBeUndefined();
	});

	it("forward-compat: ignores an unknown future trailing key, body stays clean", () => {
		// The mirror image of an older plugin ignoring [addressed ...]: our
		// parser drops trailing keys it does not recognize (per data-format
		// Migration) rather than folding them into the body.
		const text = [
			"<!-- annoteca/clarify: tighten this",
			"[id=addr0004]",
			"[addressed claude 2026-06-20]: replaced it",
			"[priority=high]",
			"-->",
		].join("\n");
		const c = parseAll(text)[0];
		expect(c?.body).toBe("tighten this");
		expect(c?.addressed?.note).toBe("replaced it");
	});

	it("round-trips an addressed comment WITH a resolution after it", () => {
		const text = [
			"<!-- annoteca/clarify: tighten this",
			"[id=addr0003]",
			"[addressed claude 2026-06-20]: replaced the sentence",
			"```annoteca-original",
			"the old sentence",
			"```",
			"[resolved charles 2026-06-21]: accepted",
			"-->",
		].join("\n");
		const c = parseAll(text)[0];
		expect(c?.addressed?.original).toBe("the old sentence");
		expect(c?.resolution?.author).toBe("charles");
		expect(c?.resolution?.note).toBe("accepted");
		expect(c?.body).toBe("tighten this");
	});
});

describe("parser: multi-party threads (F-274)", () => {
	it("round-trips a thread with several distinct authors in order", () => {
		const text = [
			"<!-- annoteca/tone: sounds off",
			"[id=multi0001]",
			"[author=human1]",
			"[reply human2 2026-06-20]: agree, too stiff",
			"[reply claude 2026-06-20]: how about this rewrite",
			"[reply human1 2026-06-21]: better, keep it",
			"[reply human2 2026-06-21]: works for me",
			"-->",
		].join("\n");
		const c = parseAll(text)[0];
		expect(c).toBeDefined();
		if (!c) return;
		expect(c.author).toBe("human1");
		expect(c.replies.map(r => r.author)).toEqual(["human2", "claude", "human1", "human2"]);
		// Serializing it back reproduces the same authors in the same order.
		const round = serialize({
			id: c.id, category: c.category, body: c.body,
			date: c.date, author: c.author, anchor: c.anchor,
			replies: c.replies, addressed: c.addressed, resolution: c.resolution,
		});
		const c2 = parseAll(round)[0];
		expect(c2?.replies.map(r => r.author)).toEqual(["human2", "claude", "human1", "human2"]);
	});
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

describe("parser: full timestamps and reply ordering", () => {
	it("parses a full timestamp on date, reply, resolved, and addressed lines", () => {
		const text = [
			"<!-- annoteca/tone: needs work",
			"[id=stamp001]",
			"[date=2026-06-22T14:30:12]",
			"[author=charles]",
			"[reply ai 2026-06-22T14:31:05]: how about this",
			"[addressed ai 2026-06-22T14:32:00]: applied",
			"[resolved charles 2026-06-22T14:33:48]: good",
			"-->",
		].join("\n");
		const c = parseAll(text)[0];
		expect(c).toBeDefined();
		if (!c) return;
		expect(c.date).toBe("2026-06-22T14:30:12");
		expect(c.replies[0]?.date).toBe("2026-06-22T14:31:05");
		expect(c.addressed?.date).toBe("2026-06-22T14:32:00");
		expect(c.resolution?.date).toBe("2026-06-22T14:33:48");
	});

	it("still parses legacy date-only stamps", () => {
		const text = [
			"<!-- annoteca/tone: legacy",
			"[date=2026-05-23]",
			"[reply ai 2026-05-23]: ok",
			"-->",
		].join("\n");
		const c = parseAll(text)[0];
		expect(c?.date).toBe("2026-05-23");
		expect(c?.replies[0]?.date).toBe("2026-05-23");
	});

	it("sorts replies by timestamp even when written out of order", () => {
		const text = [
			"<!-- annoteca/tone: ordering",
			"[id=order001]",
			"[reply ai 2026-06-22T14:33:48]: third",
			"[reply charles 2026-06-22T14:30:00]: first",
			"[reply ai 2026-06-22T14:31:05]: second",
			"-->",
		].join("\n");
		const c = parseAll(text)[0];
		expect(c?.replies.map(r => r.body)).toEqual(["first", "second", "third"]);
	});

	it("breaks ties on equal timestamps by file order (stable sort)", () => {
		const text = [
			"<!-- annoteca/tone: ties",
			"[id=ties0001]",
			"[reply a 2026-06-22T14:30:00]: one",
			"[reply b 2026-06-22T14:30:00]: two",
			"[reply c 2026-06-22T14:30:00]: three",
			"-->",
		].join("\n");
		const c = parseAll(text)[0];
		expect(c?.replies.map(r => r.author)).toEqual(["a", "b", "c"]);
	});

	it("round-trips a full-timestamp thread, re-sorting on the second parse", () => {
		const text = [
			"<!-- annoteca/tone: rt",
			"[id=rtstamp01]",
			"[reply ai 2026-06-22T09:00:00]: early",
			"[reply charles 2026-06-22T17:00:00]: late",
			"-->",
		].join("\n");
		const c = parseAll(text)[0];
		if (!c) throw new Error("no comment");
		const round = serialize({
			id: c.id, category: c.category, body: c.body, date: c.date,
			author: c.author, anchor: c.anchor, replies: c.replies,
			addressed: c.addressed, resolution: c.resolution,
		});
		const c2 = parseAll(round)[0];
		expect(c2?.replies.map(r => r.body)).toEqual(["early", "late"]);
	});
});

describe("parser: nowISO", () => {
	it("emits a full local timestamp YYYY-MM-DDTHH:MM:SS for a known instant", () => {
		expect(nowISO(new Date(2026, 4, 25, 9, 7, 3))).toBe("2026-05-25T09:07:03");
	});

	it("zero-pads every component", () => {
		expect(nowISO(new Date(2026, 0, 1, 0, 0, 0))).toBe("2026-01-01T00:00:00");
	});

	it("keeps todayISO date-only", () => {
		expect(todayISO(new Date(2026, 4, 25, 9, 7, 3))).toBe("2026-05-25");
	});
});
