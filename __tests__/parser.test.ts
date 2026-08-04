import {
	parseAll,
	parseAt,
	serialize,
	generateId,
	todayISO,
	nowISO,
	findMalformedMarkers,
	buildAnchorFromSelection,
	ANCHOR_MAX_CHARS,
} from '../parser';
import type { Comment } from '../types';

describe('parser: single-line markers', () => {
	it('parses a minimal single-line marker', () => {
		const text = `Prose. <!-- annoteca/clarify: which products? --> more prose.`;
		const comments = parseAll(text);
		expect(comments).toHaveLength(1);
		const c = comments[0];
		expect(c).toBeDefined();
		if (!c) return;
		expect(c.category).toBe('clarify');
		expect(c.body).toBe('which products?');
		expect(c.id).toBeUndefined();
		expect(c.date).toBeUndefined();
		expect(c.author).toBeUndefined();
		expect(c.replies).toEqual([]);
		expect(c.resolution).toBeUndefined();
	});

	it('parses multiple markers on one line and preserves offsets', () => {
		const text = `A <!-- annoteca/tone: x --> B <!-- annoteca/cut: y --> C`;
		const comments = parseAll(text);
		expect(comments).toHaveLength(2);
		const [first, second] = comments;
		expect(first).toBeDefined();
		expect(second).toBeDefined();
		if (!first || !second) return;
		expect(first.category).toBe('tone');
		expect(second.category).toBe('cut');
		expect(text.slice(first.marker.start, first.marker.end)).toBe(
			`<!-- annoteca/tone: x -->`,
		);
		expect(text.slice(second.marker.start, second.marker.end)).toBe(
			`<!-- annoteca/cut: y -->`,
		);
	});

	it('supports hyphenated category names', () => {
		const text = `<!-- annoteca/source-needed: cite -->`;
		const comments = parseAll(text);
		expect(comments).toHaveLength(1);
		expect(comments[0]?.category).toBe('source-needed');
	});
});

describe('parser: multi-line markers', () => {
	const fullMarker = `<!-- annoteca/tone: doesn't sound like me
[id=a3b9c2x7]
[date=2026-05-23]
[author=charles]
[reply ai 2026-05-23]: Consider "She knew, in her bones, what love felt like."
[reply charles 2026-05-24]: I like "in her bones." Trying it.
[resolved charles 2026-05-25]: rewrote the line
-->`;

	it('parses metadata, replies (chronological), and resolution', () => {
		const comments = parseAll(fullMarker);
		expect(comments).toHaveLength(1);
		const c = comments[0];
		expect(c).toBeDefined();
		if (!c) return;
		expect(c.category).toBe('tone');
		expect(c.body).toBe("doesn't sound like me");
		expect(c.id).toBe('a3b9c2x7');
		expect(c.date).toBe('2026-05-23');
		expect(c.author).toBe('charles');
		expect(c.replies).toHaveLength(2);
		expect(c.replies[0]).toEqual({
			author: 'ai',
			date: '2026-05-23',
			body: `Consider "She knew, in her bones, what love felt like."`,
		});
		expect(c.replies[1]).toEqual({
			author: 'charles',
			date: '2026-05-24',
			body: `I like "in her bones." Trying it.`,
		});
		expect(c.resolution).toEqual({
			author: 'charles',
			date: '2026-05-25',
			note: 'rewrote the line',
		});
	});

	it('treats bracket-looking body content as body when a non-structured line follows it', () => {
		const text = `<!-- annoteca/clarify: line one
[reply ai 2026-05-23]: this looks like a reply
but here is a non-structured line, which means everything above is body
-->`;
		const c = parseAll(text)[0];
		expect(c).toBeDefined();
		if (!c) return;
		expect(c.replies).toHaveLength(0);
		expect(c.body).toContain('but here is a non-structured line');
	});

	it("treats bracket-shaped trailing lines we don't recognize as structured (forward-compat)", () => {
		const text = `<!-- annoteca/tone: body here
[priority=high]
[date=2026-05-23]
-->`;
		const c = parseAll(text)[0];
		expect(c).toBeDefined();
		if (!c) return;
		expect(c.body).toBe('body here');
		expect(c.date).toBe('2026-05-23');
	});

	it('allows a bare resolution line with no note', () => {
		const text = `<!-- annoteca/tone: body
[resolved charles 2026-05-25]:
-->`;
		const c = parseAll(text)[0];
		expect(c).toBeDefined();
		if (!c) return;
		expect(c.resolution).toEqual({
			author: 'charles',
			date: '2026-05-25',
			note: '',
		});
	});

	it('preserves mixed-case and dotted authors in author, reply, and resolved lines', () => {
		const text = `<!-- annoteca/tone: body
[author=J.Doe]
[reply AI-Bot 2026-05-23]: a reply
[resolved Charles 2026-05-25]: done
-->`;
		const c = parseAll(text)[0];
		expect(c).toBeDefined();
		if (!c) return;
		expect(c.author).toBe('J.Doe');
		expect(c.replies[0]?.author).toBe('AI-Bot');
		expect(c.resolution).toEqual({
			author: 'Charles',
			date: '2026-05-25',
			note: 'done',
		});
	});
});

describe('parser: anchor', () => {
	it('parses a tail [anchor=...] line into a Comment.anchor object', () => {
		const text = [
			`<!-- annoteca/clarify: which products?`,
			`[id=a3b9c2x7]`,
			`[anchor=quantitative targets such as reduced review time]`,
			`-->`,
		].join('\n');
		const [c] = parseAll(text);
		expect(c).toBeDefined();
		if (!c) return;
		expect(c.anchor).toBeDefined();
		expect(c.anchor?.text).toBe(
			'quantitative targets such as reduced review time',
		);
		expect(c.anchor?.truncated).toBe(false);
	});

	it('treats an anchor containing a U+2026 ellipsis as truncated', () => {
		const text = [
			`<!-- annoteca/clarify: x`,
			`[anchor=opening words…closing words]`,
			`-->`,
		].join('\n');
		const [c] = parseAll(text);
		expect(c?.anchor?.truncated).toBe(true);
	});

	it('round-trips a comment with an anchor through serialize and parseAll', () => {
		const s = serialize({
			category: 'tone',
			body: 'needs work',
			id: 'a3b9c2x7',
			date: '2026-05-26',
			anchor: { text: 'the cold morning air', truncated: false },
		});
		const [c] = parseAll(s);
		expect(c?.anchor).toEqual({
			text: 'the cold morning air',
			truncated: false,
		});
	});

	it('emits no [anchor=...] line when the comment has no anchor', () => {
		const s = serialize({
			category: 'tone',
			body: 'needs work',
			id: 'a3b9c2x7',
			date: '2026-05-26',
		});
		expect(s).not.toContain('[anchor=');
	});
});

describe('buildAnchorFromSelection', () => {
	it('returns undefined for empty or whitespace-only selections', () => {
		expect(buildAnchorFromSelection('')).toBeUndefined();
		expect(buildAnchorFromSelection('   \n\t')).toBeUndefined();
	});

	it('strips line breaks and `]` characters from the captured text', () => {
		const a = buildAnchorFromSelection('first line\nsecond ]line]');
		expect(a?.text).toBe('first line second line');
		expect(a?.truncated).toBe(false);
	});

	it('collapses internal whitespace to single spaces', () => {
		const a = buildAnchorFromSelection('a    b\t\tc');
		expect(a?.text).toBe('a b c');
	});

	it('returns the cleaned text untruncated when within the cap', () => {
		const a = buildAnchorFromSelection('short selection');
		expect(a?.truncated).toBe(false);
		expect(a?.text).toBe('short selection');
	});

	it('mid-truncates with a single U+2026 when over the cap', () => {
		const long = 'x'.repeat(60) + ' middle ' + 'y'.repeat(60);
		const a = buildAnchorFromSelection(long);
		expect(a?.truncated).toBe(true);
		expect(a?.text.includes('…')).toBe(true);
		// The stored value must not exceed the cap.
		expect(a?.text.length).toBeLessThanOrEqual(ANCHOR_MAX_CHARS);
		// Both ends are preserved.
		expect(a?.text.startsWith('x')).toBe(true);
		expect(a?.text.endsWith('y')).toBe(true);
	});
});

describe('parser: serialize', () => {
	it('emits the single-line form when there is no metadata', () => {
		const s = serialize({ category: 'clarify', body: 'which products?' });
		expect(s).toBe(`<!-- annoteca/clarify: which products? -->`);
	});

	it('emits the multi-line form when any metadata is present', () => {
		const s = serialize({
			category: 'tone',
			body: "doesn't sound like me",
			id: 'a3b9c2x7',
			date: '2026-05-23',
		});
		expect(s).toBe(
			[
				"<!-- annoteca/tone: doesn't sound like me",
				'[id=a3b9c2x7]',
				'[date=2026-05-23]',
				'-->',
			].join('\n'),
		);
	});

	it('emits the multi-line form when the body itself spans lines', () => {
		const s = serialize({ category: 'tone', body: 'line a\nline b' });
		expect(s).toBe(
			['<!-- annoteca/tone: line a', 'line b', '-->'].join('\n'),
		);
	});
});

describe('parser: round-trip property', () => {
	const cases: Comment[] = [
		{
			id: undefined,
			category: 'tone',
			body: 'short body',
			date: undefined,
			author: undefined,
			anchor: undefined,
			replies: [],
			addressed: undefined,
			resolution: undefined,
			marker: { start: 0, end: 0 },
		},
		{
			id: 'a3b9c2x7',
			category: 'tone',
			body: "doesn't sound like me",
			date: '2026-05-23',
			author: 'charles',
			anchor: undefined,
			replies: [
				{ author: 'ai', date: '2026-05-23', body: 'consider X' },
				{ author: 'charles', date: '2026-05-24', body: 'trying it' },
			],
			addressed: undefined,
			resolution: undefined,
			marker: { start: 0, end: 0 },
		},
		{
			id: 'z1z1z1z1',
			category: 'source-needed',
			body: 'needs citation',
			date: '2026-05-25',
			author: 'ai',
			anchor: undefined,
			replies: [],
			addressed: undefined,
			resolution: {
				author: 'charles',
				date: '2026-05-25',
				note: 'added in revision pass',
			},
			marker: { start: 0, end: 0 },
		},
		{
			id: 'anchor01',
			category: 'clarify',
			body: 'be specific',
			date: '2026-05-26',
			author: undefined,
			anchor: { text: 'the cold morning air', truncated: false },
			replies: [],
			addressed: undefined,
			resolution: undefined,
			marker: { start: 0, end: 0 },
		},
		// F-270/F-271: addressed state with a single-line note and a multi-line
		// annoteca-original fence, plus a reply before it. Exercises ordering
		// (reply, addressed+fence) and lossless original round-trip.
		{
			id: 'addr0001',
			category: 'clarify',
			body: 'tighten this',
			date: '2026-06-20',
			author: 'charles',
			anchor: { text: 'it landed as a shock', truncated: false },
			replies: [
				{ author: 'charles', date: '2026-06-20', body: 'go ahead' },
			],
			addressed: {
				author: 'claude',
				date: '2026-06-20',
				note: 'Cut the self-deprecating framing.',
				original:
					'So when I finally read it slowly,\nit landed as a shock.',
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
				id: c.id,
				category: c.category,
				body: c.body,
				date: c.date,
				author: c.author,
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

describe('parser: addressed state (F-270/F-271)', () => {
	const addressedMarker = [
		'<!-- annoteca/clarify: tighten this',
		'[id=addr0001]',
		'[date=2026-06-20]',
		'[anchor=it landed as a shock]',
		'[reply charles 2026-06-20]: go ahead',
		'[addressed claude 2026-06-20]: Cut the framing.',
		'```annoteca-original',
		'So when I finally read it slowly,',
		'it landed as a shock.',
		'```',
		'-->',
	].join('\n');

	it('parses the [addressed ...] line and extracts the annoteca-original fence', () => {
		const c = parseAll(addressedMarker)[0];
		expect(c).toBeDefined();
		if (!c) return;
		expect(c.addressed).toBeDefined();
		expect(c.addressed?.author).toBe('claude');
		expect(c.addressed?.date).toBe('2026-06-20');
		expect(c.addressed?.note).toBe('Cut the framing.');
		expect(c.addressed?.original).toBe(
			'So when I finally read it slowly,\nit landed as a shock.',
		);
	});

	it('leaves the body clean (fence and addressed line are not body text)', () => {
		const c = parseAll(addressedMarker)[0];
		expect(c?.body).toBe('tighten this');
	});

	it('keeps the reply that precedes the addressed line', () => {
		const c = parseAll(addressedMarker)[0];
		expect(c?.replies).toEqual([
			{ author: 'charles', date: '2026-06-20', body: 'go ahead' },
		]);
	});

	it('still matches the canonical marker (greppable, full span through -->)', () => {
		const comments = parseAll(`prefix ${addressedMarker} suffix`);
		expect(comments).toHaveLength(1);
	});

	it('parses an addressed line with no fence (addressed without replacement)', () => {
		const text = [
			'<!-- annoteca/clarify: tighten this',
			'[id=addr0002]',
			'[addressed claude 2026-06-20]: tweaked in place',
			'-->',
		].join('\n');
		const c = parseAll(text)[0];
		expect(c?.addressed?.note).toBe('tweaked in place');
		expect(c?.addressed?.original).toBeUndefined();
	});

	it('treats a comment with no addressed line as open (addressed undefined)', () => {
		const text = '<!-- annoteca/clarify: which products? -->';
		expect(parseAll(text)[0]?.addressed).toBeUndefined();
	});

	it('forward-compat: ignores an unknown future trailing key, body stays clean', () => {
		// The mirror image of an older plugin ignoring [addressed ...]: our
		// parser drops trailing keys it does not recognize (per data-format
		// Migration) rather than folding them into the body.
		const text = [
			'<!-- annoteca/clarify: tighten this',
			'[id=addr0004]',
			'[addressed claude 2026-06-20]: replaced it',
			'[priority=high]',
			'-->',
		].join('\n');
		const c = parseAll(text)[0];
		expect(c?.body).toBe('tighten this');
		expect(c?.addressed?.note).toBe('replaced it');
	});

	it('round-trips an addressed comment WITH a resolution after it', () => {
		const text = [
			'<!-- annoteca/clarify: tighten this',
			'[id=addr0003]',
			'[addressed claude 2026-06-20]: replaced the sentence',
			'```annoteca-original',
			'the old sentence',
			'```',
			'[resolved charles 2026-06-21]: accepted',
			'-->',
		].join('\n');
		const c = parseAll(text)[0];
		expect(c?.addressed?.original).toBe('the old sentence');
		expect(c?.resolution?.author).toBe('charles');
		expect(c?.resolution?.note).toBe('accepted');
		expect(c?.body).toBe('tighten this');
	});
});

describe('parser: multi-party threads (F-274)', () => {
	it('round-trips a thread with several distinct authors in order', () => {
		const text = [
			'<!-- annoteca/tone: sounds off',
			'[id=multi0001]',
			'[author=human1]',
			'[reply human2 2026-06-20]: agree, too stiff',
			'[reply claude 2026-06-20]: how about this rewrite',
			'[reply human1 2026-06-21]: better, keep it',
			'[reply human2 2026-06-21]: works for me',
			'-->',
		].join('\n');
		const c = parseAll(text)[0];
		expect(c).toBeDefined();
		if (!c) return;
		expect(c.author).toBe('human1');
		expect(c.replies.map((r) => r.author)).toEqual([
			'human2',
			'claude',
			'human1',
			'human2',
		]);
		// Serializing it back reproduces the same authors in the same order.
		const round = serialize({
			id: c.id,
			category: c.category,
			body: c.body,
			date: c.date,
			author: c.author,
			anchor: c.anchor,
			replies: c.replies,
			addressed: c.addressed,
			resolution: c.resolution,
		});
		const c2 = parseAll(round)[0];
		expect(c2?.replies.map((r) => r.author)).toEqual([
			'human2',
			'claude',
			'human1',
			'human2',
		]);
	});
});

describe('parser: parseAt', () => {
	it('returns the marker at a known offset', () => {
		const text = `prefix <!-- annoteca/tone: body --> suffix`;
		const start = text.indexOf('<!--');
		const c = parseAt(text, start);
		expect(c).toBeDefined();
		expect(c?.category).toBe('tone');
	});

	it('returns undefined when no marker starts at the given offset', () => {
		const text = `prefix <!-- annoteca/tone: body --> suffix`;
		expect(parseAt(text, 0)).toBeUndefined();
	});
});

describe('parser: generateId / todayISO', () => {
	it('generates an 8-character base36 id', () => {
		for (let i = 0; i < 64; i++) {
			const id = generateId();
			expect(id).toHaveLength(8);
			expect(id).toMatch(/^[a-z0-9]{8}$/);
		}
	});

	it('emits ISO YYYY-MM-DD for a known date', () => {
		expect(todayISO(new Date(2026, 4, 25))).toBe('2026-05-25');
	});
});

describe('parser: findMalformedMarkers', () => {
	it('returns nothing for well-formed markers', () => {
		const text = `<!-- annoteca/tone: x -->`;
		expect(findMalformedMarkers(text)).toEqual([]);
	});

	it('flags an unclosed marker shell', () => {
		const text = `<!-- annoteca/TONE: x --> end`;
		const flagged = findMalformedMarkers(text);
		expect(flagged.length).toBeGreaterThanOrEqual(1);
	});
});

describe('parser: full timestamps and reply ordering', () => {
	it('parses a full timestamp on date, reply, resolved, and addressed lines', () => {
		const text = [
			'<!-- annoteca/tone: needs work',
			'[id=stamp001]',
			'[date=2026-06-22T14:30:12]',
			'[author=charles]',
			'[reply ai 2026-06-22T14:31:05]: how about this',
			'[addressed ai 2026-06-22T14:32:00]: applied',
			'[resolved charles 2026-06-22T14:33:48]: good',
			'-->',
		].join('\n');
		const c = parseAll(text)[0];
		expect(c).toBeDefined();
		if (!c) return;
		expect(c.date).toBe('2026-06-22T14:30:12');
		expect(c.replies[0]?.date).toBe('2026-06-22T14:31:05');
		expect(c.addressed?.date).toBe('2026-06-22T14:32:00');
		expect(c.resolution?.date).toBe('2026-06-22T14:33:48');
	});

	it('still parses legacy date-only stamps', () => {
		const text = [
			'<!-- annoteca/tone: legacy',
			'[date=2026-05-23]',
			'[reply ai 2026-05-23]: ok',
			'-->',
		].join('\n');
		const c = parseAll(text)[0];
		expect(c?.date).toBe('2026-05-23');
		expect(c?.replies[0]?.date).toBe('2026-05-23');
	});

	it('sorts replies by timestamp even when written out of order', () => {
		const text = [
			'<!-- annoteca/tone: ordering',
			'[id=order001]',
			'[reply ai 2026-06-22T14:33:48]: third',
			'[reply charles 2026-06-22T14:30:00]: first',
			'[reply ai 2026-06-22T14:31:05]: second',
			'-->',
		].join('\n');
		const c = parseAll(text)[0];
		expect(c?.replies.map((r) => r.body)).toEqual([
			'first',
			'second',
			'third',
		]);
	});

	it('breaks ties on equal timestamps by file order (stable sort)', () => {
		const text = [
			'<!-- annoteca/tone: ties',
			'[id=ties0001]',
			'[reply a 2026-06-22T14:30:00]: one',
			'[reply b 2026-06-22T14:30:00]: two',
			'[reply c 2026-06-22T14:30:00]: three',
			'-->',
		].join('\n');
		const c = parseAll(text)[0];
		expect(c?.replies.map((r) => r.author)).toEqual(['a', 'b', 'c']);
	});

	it('round-trips a full-timestamp thread, re-sorting on the second parse', () => {
		const text = [
			'<!-- annoteca/tone: rt',
			'[id=rtstamp01]',
			'[reply ai 2026-06-22T09:00:00]: early',
			'[reply charles 2026-06-22T17:00:00]: late',
			'-->',
		].join('\n');
		const c = parseAll(text)[0];
		if (!c) throw new Error('no comment');
		const round = serialize({
			id: c.id,
			category: c.category,
			body: c.body,
			date: c.date,
			author: c.author,
			anchor: c.anchor,
			replies: c.replies,
			addressed: c.addressed,
			resolution: c.resolution,
		});
		const c2 = parseAll(round)[0];
		expect(c2?.replies.map((r) => r.body)).toEqual(['early', 'late']);
	});
});

describe('parser: nowISO', () => {
	it('emits a full local timestamp YYYY-MM-DDTHH:MM:SS for a known instant', () => {
		expect(nowISO(new Date(2026, 4, 25, 9, 7, 3))).toBe(
			'2026-05-25T09:07:03',
		);
	});

	it('zero-pads every component', () => {
		expect(nowISO(new Date(2026, 0, 1, 0, 0, 0))).toBe(
			'2026-01-01T00:00:00',
		);
	});

	it('keeps todayISO date-only', () => {
		expect(todayISO(new Date(2026, 4, 25, 9, 7, 3))).toBe('2026-05-25');
	});
});

// The rule that used to sit here matched any line starting `[`, so the last
// line of a body was deleted whenever it began with a bracket. Markdown is full
// of bracket-leading constructs and Obsidian's wikilink is one, which makes this
// reachable from ordinary prose rather than from a crafted edge case.
describe('parser: bracket-leading markdown at the end of a body', () => {
	const bodyEndingWith = (lastLine: string): string | undefined =>
		parseAll(
			[
				'<!-- annoteca/note: Some prose.',
				lastLine,
				'[id=abc12345]',
				'-->',
			].join('\n'),
		)[0]?.body;

	it('keeps an inline markdown link', () => {
		expect(bodyEndingWith('[the guide](https://example.com/guide)')).toBe(
			'Some prose.\n[the guide](https://example.com/guide)',
		);
	});

	it('keeps a single-word reference-style link definition', () => {
		expect(bodyEndingWith('[ref]: https://example.com')).toBe(
			'Some prose.\n[ref]: https://example.com',
		);
	});

	// The nastiest case: multi-word label plus `]:` looks exactly like the
	// `[keyword ...]:` note lines the format defines. Disambiguated by requiring
	// a timestamp, which every real note line carries.
	it('keeps a multi-word reference-style link definition', () => {
		expect(bodyEndingWith('[see the docs]: https://example.com')).toBe(
			'Some prose.\n[see the docs]: https://example.com',
		);
	});

	it('keeps a footnote definition', () => {
		expect(bodyEndingWith('[^1]: a footnote')).toBe(
			'Some prose.\n[^1]: a footnote',
		);
	});

	it('keeps an Obsidian wikilink', () => {
		expect(bodyEndingWith('[[Some Note]]')).toBe(
			'Some prose.\n[[Some Note]]',
		);
	});

	it('keeps a task-list-shaped line', () => {
		expect(bodyEndingWith('[x] done')).toBe('Some prose.\n[x] done');
	});

	it('still drops an unknown [key=value] line (forward-compat)', () => {
		expect(bodyEndingWith('[priority=high]')).toBe('Some prose.');
	});

	it('still drops an unknown stamped keyword line (forward-compat)', () => {
		expect(bodyEndingWith('[assigned bob 2026-06-20]: take a look')).toBe(
			'Some prose.',
		);
	});
});

// `-->` closes the HTML comment wrapping every marker. Before the escape it
// serialized raw, so the marker ended early and the remainder of the body was
// left behind as visible text in the user's document.
describe('parser: `-->` in free text round-trips', () => {
	const roundTrip = (
		c: Parameters<typeof serialize>[0],
	): Comment | undefined => parseAll(serialize(c))[0];

	it('survives in a single-line body', () => {
		const out = serialize({ category: 'note', body: 'arrow --> here' });
		expect(out).toBe('<!-- annoteca/note: arrow --\\> here -->');
		expect(parseAll(out)).toHaveLength(1);
		expect(parseAll(out)[0]?.body).toBe('arrow --> here');
	});

	it('survives in a multi-line body', () => {
		const c = roundTrip({
			category: 'note',
			body: 'line one\narrow --> here',
			id: 'abc12345',
		});
		expect(c?.body).toBe('line one\narrow --> here');
	});

	it('survives in a reply body', () => {
		const c = roundTrip({
			category: 'note',
			body: 'body',
			replies: [{ author: 'bob', date: '2026-06-20', body: 'a --> b' }],
		});
		expect(c?.replies[0]?.body).toBe('a --> b');
	});

	it('survives in a resolution note', () => {
		const c = roundTrip({
			category: 'note',
			body: 'body',
			resolution: { author: 'bob', date: '2026-06-20', note: 'a --> b' },
		});
		expect(c?.resolution?.note).toBe('a --> b');
	});

	it('survives in an addressed note and its original fence', () => {
		const c = roundTrip({
			category: 'note',
			body: 'body',
			addressed: {
				author: 'claude',
				date: '2026-06-20',
				note: 'changed a --> b',
				original: 'the old a --> b text',
			},
		});
		expect(c?.addressed?.note).toBe('changed a --> b');
		expect(c?.addressed?.original).toBe('the old a --> b text');
	});

	it('survives in an anchor', () => {
		const c = roundTrip({
			category: 'note',
			body: 'body',
			anchor: { text: 'points --> there', truncated: false },
		});
		expect(c?.anchor?.text).toBe('points --> there');
	});

	it('emits exactly one `-->` per marker, the terminator', () => {
		const out = serialize({
			category: 'note',
			body: 'a --> b\nc --> d',
			id: 'abc12345',
			replies: [{ author: 'bob', date: '2026-06-20', body: 'e --> f' }],
			resolution: { author: 'bob', date: '2026-06-21', note: 'g --> h' },
		});
		expect(out.split('-->')).toHaveLength(2);
		expect(out.endsWith('\n-->')).toBe(true);
	});

	it('leaves text without the sequence untouched', () => {
		const out = serialize({ category: 'note', body: 'a -> b and a --- c' });
		expect(out).toBe('<!-- annoteca/note: a -> b and a --- c -->');
	});
});

// The escape marker has to survive round-tripping too, or a body that already
// contained the literal `--\>` comes back with the backslash silently removed.
// Worst in the annoteca-original fence, whose contract is a VERBATIM restore.
describe('parser: the `-->` escape is reversible at every depth', () => {
	const roundTripBody = (body: string): string | undefined =>
		parseAll(serialize({ category: 'note', body, id: 'abc12345' }))[0]
			?.body;

	it('round-trips a literal --\\> written by the user', () => {
		expect(roundTripBody('a --\\> b')).toBe('a --\\> b');
	});

	it('round-trips a literal --\\\\> written by the user', () => {
		expect(roundTripBody('a --\\\\> b')).toBe('a --\\\\> b');
	});

	it('round-trips the real terminator and a literal escape side by side', () => {
		expect(roundTripBody('real --> and literal --\\> together')).toBe(
			'real --> and literal --\\> together',
		);
	});

	it('keeps an annoteca-original fence verbatim', () => {
		const original = 'He said --> and she wrote --\\> in reply.';
		const out = serialize({
			category: 'note',
			body: 'body',
			addressed: {
				author: 'claude',
				date: '2026-06-20',
				note: 'edited',
				original,
			},
		});
		expect(parseAll(out)[0]?.addressed?.original).toBe(original);
	});

	it('never emits a bare terminator inside the marker', () => {
		const out = serialize({
			category: 'note',
			body: 'a --> b --\\> c --\\\\> d',
			id: 'abc12345',
		});
		expect(out.split('-->')).toHaveLength(2);
	});
});

// Bounding the one case the escape cannot disambiguate: a marker written by a
// version that predates it, whose text legitimately contains a literal `--\>`.
// There is no sentinel in the old format, so a reader cannot tell that from an
// encoded terminator. What matters is how far the consequence actually reaches.
describe('parser: legacy markers containing a literal --\\>', () => {
	const legacy = [
		'<!-- annoteca/note: an escaped arrow --\\> written before encoding existed',
		'[id=legacy01]',
		'-->',
	].join('\n');

	it('reads one backslash off, which is the known limitation', () => {
		expect(parseAll(legacy)[0]?.body).toBe(
			'an escaped arrow --> written before encoding existed',
		);
	});

	// The important half: parse + re-serialize is a fixed point, so merely
	// opening a vault does not rewrite anyone's files, and repeated edits do not
	// walk the text further with each pass.
	it('round-trips byte-identically, so the file is never rewritten', () => {
		const parsed = parseAll(legacy)[0];
		expect(parsed).toBeDefined();
		if (!parsed) return;
		expect(
			serialize({
				id: parsed.id,
				category: parsed.category,
				body: parsed.body,
				date: parsed.date,
				author: parsed.author,
				anchor: parsed.anchor,
				replies: parsed.replies,
				addressed: parsed.addressed,
				resolution: parsed.resolution,
			}),
		).toBe(legacy);
	});

	it('is stable across repeated parse/serialize passes', () => {
		let text = legacy;
		for (let i = 0; i < 5; i++) {
			const c = parseAll(text)[0];
			if (!c) throw new Error('lost the marker');
			text = serialize({
				id: c.id,
				category: c.category,
				body: c.body,
				date: c.date,
				author: c.author,
				anchor: c.anchor,
				replies: c.replies,
				addressed: c.addressed,
				resolution: c.resolution,
			});
		}
		expect(text).toBe(legacy);
	});
});

describe('parser: a newline in a single-line field cannot destroy the marker', () => {
	const roundTrip = (
		c: Parameters<typeof serialize>[0],
	): Comment | undefined => parseAll(serialize(c))[0];

	// Every bracketed trailing line is matched per line, so a raw newline in one
	// of these fields used to end the backward walk on the continuation line and
	// absorb the whole trailing block, the [id=...] included, into the body.
	it('keeps the id, the thread and the body when a reply spans lines', () => {
		const c = roundTrip({
			category: 'note',
			body: 'the body',
			id: 'abcd1234',
			date: '2024-01-01',
			replies: [
				{
					author: 'amy',
					date: '2024-01-02',
					body: '- first point\n- second point',
				},
			],
		});
		expect(c?.id).toBe('abcd1234');
		expect(c?.body).toBe('the body');
		expect(c?.replies).toHaveLength(1);
		expect(c?.replies[0]?.body).toBe('- first point - second point');
	});

	it('collapses a newline in a resolution note', () => {
		const c = roundTrip({
			category: 'note',
			body: 'body',
			id: 'abcd1234',
			resolution: { author: 'bob', date: '2026-06-20', note: 'a\nb' },
		});
		expect(c?.id).toBe('abcd1234');
		expect(c?.resolution?.note).toBe('a b');
	});

	it('collapses a newline in an addressed note, leaving the fence alone', () => {
		const c = roundTrip({
			category: 'note',
			body: 'body',
			id: 'abcd1234',
			addressed: {
				author: 'claude',
				date: '2026-06-20',
				note: 'first\nsecond',
				original: 'kept\nacross\nlines',
			},
		});
		expect(c?.id).toBe('abcd1234');
		expect(c?.addressed?.note).toBe('first second');
		// The fence is delimited, not line-oriented, so it must stay multi-line.
		expect(c?.addressed?.original).toBe('kept\nacross\nlines');
	});

	it('collapses a newline in an anchor', () => {
		const c = roundTrip({
			category: 'note',
			body: 'body',
			id: 'abcd1234',
			anchor: { text: 'which\nproducts', truncated: false },
		});
		expect(c?.id).toBe('abcd1234');
		expect(c?.anchor?.text).toBe('which products');
	});

	it('leaves a multi-line body multi-line', () => {
		const c = roundTrip({
			category: 'note',
			body: 'line one\nline two',
			id: 'abcd1234',
		});
		expect(c?.body).toBe('line one\nline two');
	});

	it('collapses a run of blank lines to one space, and handles CRLF', () => {
		const c = roundTrip({
			category: 'note',
			body: 'body',
			replies: [
				{ author: 'amy', date: '2024-01-02', body: 'a\r\n\n\nb' },
			],
		});
		expect(c?.replies[0]?.body).toBe('a b');
	});

	it('still escapes the terminator in a field it also collapses', () => {
		const c = roundTrip({
			category: 'note',
			body: 'body',
			replies: [{ author: 'amy', date: '2024-01-02', body: 'a -->\nb' }],
		});
		expect(c?.replies[0]?.body).toBe('a --> b');
	});
});

describe('parser: a code fence inside the captured original cannot close the block', () => {
	const roundTrip = (
		c: Parameters<typeof serialize>[0],
	): Comment | undefined => parseAll(serialize(c))[0];

	// The fence is the second terminator, alongside `-->`. The captured prose is
	// arbitrary text lifted out of the user's document, so it can hold a code
	// block; a fixed ``` delimiter closed the fence on that line and the
	// addressed state, the id and the original were all lost.
	it('keeps the original, the addressed state and the id', () => {
		const original = 'before\n```js\nconst a = 1;\n```\nafter';
		const c = roundTrip({
			category: 'note',
			body: 'b',
			id: 'abcd1234',
			addressed: {
				author: 'amy',
				date: '2024-01-01',
				note: 'n',
				original,
			},
		});
		expect(c?.id).toBe('abcd1234');
		expect(c?.body).toBe('b');
		expect(c?.addressed?.note).toBe('n');
		expect(c?.addressed?.original).toBe(original);
	});

	it('widens the fence past the longest run in the content', () => {
		const out = serialize({
			category: 'note',
			body: 'b',
			addressed: {
				author: 'amy',
				date: '2024-01-01',
				note: 'n',
				original: '````\nnested\n````',
			},
		});
		expect(out).toContain('`````annoteca-original');
	});

	it('still writes a plain three-backtick fence for ordinary prose', () => {
		const out = serialize({
			category: 'note',
			body: 'b',
			addressed: {
				author: 'amy',
				date: '2024-01-01',
				note: 'n',
				original: 'just prose',
			},
		});
		expect(out).toContain('```annoteca-original');
		expect(out).not.toContain('````annoteca-original');
	});

	it('still reads a legacy three-backtick marker written before this change', () => {
		const legacy = [
			'<!-- annoteca/note: b',
			'[id=abcd1234]',
			'[addressed amy 2024-01-01]: n',
			'```annoteca-original',
			'the old sentence',
			'```',
			'-->',
		].join('\n');
		const c = parseAll(legacy)[0];
		expect(c?.id).toBe('abcd1234');
		expect(c?.addressed?.original).toBe('the old sentence');
	});

	it('survives a fence and an arrow together', () => {
		const original = 'a --> b\n```\ncode\n```';
		const c = roundTrip({
			category: 'note',
			body: 'b',
			id: 'abcd1234',
			addressed: {
				author: 'amy',
				date: '2024-01-01',
				note: 'n',
				original,
			},
		});
		expect(c?.addressed?.original).toBe(original);
		expect(c?.id).toBe('abcd1234');
	});
});

describe('parser: an annoteca-original fence in a body is body text, not an original', () => {
	const roundTrip = (
		c: Parameters<typeof serialize>[0],
	): Comment | undefined => parseAll(serialize(c))[0];

	// Lifting out any block tagged annoteca-original deleted it from the file,
	// because originalText is dropped when there is no addressed note to hang it
	// on. Only a fence directly after the [addressed ...] line is an original.
	it('keeps a three-backtick fence written in a body', () => {
		const body =
			'the format looks like:\n```annoteca-original\nold text\n```\nclear?';
		const c = roundTrip({ category: 'note', body, id: 'abcd1234' });
		expect(c?.body).toBe(body);
		expect(c?.id).toBe('abcd1234');
		expect(c?.addressed).toBeUndefined();
	});

	it('keeps a longer fence written in a body', () => {
		const body = 'nested:\n````annoteca-original\ninner\n````\ndone';
		const c = roundTrip({ category: 'note', body, id: 'abcd1234' });
		expect(c?.body).toBe(body);
	});

	it('still lifts the fence that follows an [addressed ...] line', () => {
		const c = roundTrip({
			category: 'note',
			body: 'b',
			id: 'abcd1234',
			addressed: {
				author: 'amy',
				date: '2024-01-01',
				note: 'n',
				original: 'the old sentence',
			},
		});
		expect(c?.addressed?.original).toBe('the old sentence');
		expect(c?.body).toBe('b');
	});

	it('picks the addressed fence even when the body shows one first', () => {
		const c = roundTrip({
			category: 'note',
			body: 'example:\n```annoteca-original\ndecoy\n```',
			id: 'abcd1234',
			addressed: {
				author: 'amy',
				date: '2024-01-01',
				note: 'n',
				original: 'the real original',
			},
		});
		expect(c?.addressed?.original).toBe('the real original');
		expect(c?.body).toBe('example:\n```annoteca-original\ndecoy\n```');
	});
});

describe('parser: the original fence need not touch the [addressed ...] line', () => {
	// serialize() writes the fence immediately after the [addressed ...] line,
	// so the plugin never produces any of the markers below. Hand-written and
	// ASSISTANT-written ones do, and an assistant writing markers is the whole
	// premise: data-format.md says only "inside the [addressed ...] note", a
	// blank line before a fenced block is ordinary Markdown, and nothing stops a
	// [reply ...] or [resolved ...] line from landing in between.
	//
	// Requiring adjacency left the fence sitting in the content, and the
	// backward line-walk stops dead on a line it cannot classify. The whole
	// trailing block then collapsed into the body: no id, no addressed state,
	// no original. Accept/Revise/Reject stop rendering, Reject can no longer
	// restore the prose, and findMalformedMarkers does not flag any of it,
	// because the marker is perfectly well-formed.
	const marker = (...between: string[]): string =>
		[
			'<!-- annoteca/clarify: tighten this',
			'[id=abcd1234]',
			'[date=2026-06-20]',
			'[addressed claude 2026-06-20]: Cut the framing.',
			...between,
			'```annoteca-original',
			'the old sentence',
			'```',
			'-->',
		].join('\n');

	const expectIntact = (c: Comment | undefined): void => {
		expect(c?.id).toBe('abcd1234');
		expect(c?.body).toBe('tighten this');
		expect(c?.addressed?.note).toBe('Cut the framing.');
		expect(c?.addressed?.original).toBe('the old sentence');
	};

	it('reads a fence separated by a blank line', () => {
		expectIntact(parseAll(marker(''))[0]);
	});

	it('reads a fence with a [reply ...] line in between', () => {
		const c = parseAll(marker('[reply bob 2026-06-21]: looks good'))[0];
		expectIntact(c);
		expect(c?.replies).toHaveLength(1);
	});

	it('reads a fence written after the [resolved ...] line', () => {
		const c = parseAll(marker('[resolved bob 2026-06-21]: done'))[0];
		expectIntact(c);
		expect(c?.resolution?.note).toBe('done');
	});

	it('reads a fence separated by a blank line in a CRLF file', () => {
		const c = parseAll(marker('').replace(/\n/g, '\r\n'))[0];
		expect(c?.id).toBe('abcd1234');
		expect(c?.addressed?.original).toBe('the old sentence');
	});

	it('leaves a fence written ABOVE the [addressed ...] line in the body', () => {
		// It cannot be that note's original, so it is prose. The trailing block
		// below it still parses.
		const c = parseAll(
			[
				'<!-- annoteca/clarify: the format looks like',
				'```annoteca-original',
				'old text',
				'```',
				'[addressed claude 2026-06-20]: Cut the framing.',
				'-->',
			].join('\n'),
		)[0];
		expect(c?.body).toBe(
			'the format looks like\n```annoteca-original\nold text\n```',
		);
		expect(c?.addressed?.note).toBe('Cut the framing.');
		expect(c?.addressed?.original).toBeUndefined();
	});

	it('keeps a whole marker quoted in a body when there is no real addressed note', () => {
		// The [addressed ...] line here is prose, and the walk is what says so:
		// it stops on "clear?" and never reaches the quote. Lifting the fence
		// out on that line's say-so would delete the quote from the file, so
		// the strip is thrown away as soon as the walk reports no addressed
		// note, and the untouched content is walked instead.
		const body = [
			'here is what one looks like',
			'[addressed amy 2024-01-01]: n',
			'```annoteca-original',
			'old text',
			'```',
			'clear?',
		].join('\n');
		const c = parseAll(
			['<!-- annoteca/note: ' + body, '[id=abcd1234]', '-->'].join('\n'),
		)[0];
		expect(c?.body).toBe(body);
		expect(c?.id).toBe('abcd1234');
		expect(c?.addressed).toBeUndefined();
	});

	it('prefers the real fence over one quoted higher in the body', () => {
		// The anchor is the LAST [addressed ...] line, which is the one the walk
		// itself keeps, so the quote above it stays prose.
		const c = parseAll(
			[
				'<!-- annoteca/note: here is what one looks like',
				'[addressed amy 2024-01-01]: n',
				'```annoteca-original',
				'decoy',
				'```',
				'[id=abcd1234]',
				'[addressed claude 2026-06-20]: real',
				'```annoteca-original',
				'the real original',
				'```',
				'-->',
			].join('\n'),
		)[0];
		expect(c?.id).toBe('abcd1234');
		expect(c?.addressed?.note).toBe('real');
		expect(c?.addressed?.original).toBe('the real original');
		expect(c?.body).toBe(
			'here is what one looks like\n[addressed amy 2024-01-01]: n\n```annoteca-original\ndecoy\n```',
		);
	});

	it('recovers the marker when a second fence follows the addressed note', () => {
		// Deliberate trade, and the same one the walk already makes for a
		// duplicate [addressed ...] or [resolved ...] line: the format carries
		// one original, so the first wins and the extra block is dropped. The
		// alternative is leaving it in place, which stops the walk and destroys
		// the whole comment.
		const c = parseAll(
			[
				'<!-- annoteca/note: b',
				'[id=abcd1234]',
				'[addressed claude 2026-06-20]: n',
				'```annoteca-original',
				'first',
				'```',
				'```annoteca-original',
				'second',
				'```',
				'-->',
			].join('\n'),
		)[0];
		expect(c?.id).toBe('abcd1234');
		expect(c?.body).toBe('b');
		expect(c?.addressed?.original).toBe('first');
	});

	it('ignores an [addressed ...] line stored INSIDE the original', () => {
		// The fence holds prose lifted verbatim out of the document, so it can
		// hold a line shaped like [addressed ...] exactly as it can hold a code
		// fence or a `-->`, and serialize() writes one when the replaced passage
		// had one. Counting it would put the anchor inside the block, which
		// starts before it, so the real fence would look like a body fence and
		// be left behind to stop the walk.
		const original =
			'she wrote:\n[addressed amy 2024-01-01]: n\nand left it there';
		const marker = serialize({
			category: 'note',
			body: 'b',
			id: 'abcd1234',
			addressed: {
				author: 'claude',
				date: '2026-06-20',
				note: 'trimmed',
				original,
			},
		});
		const c = parseAll(marker)[0];
		expect(c?.id).toBe('abcd1234');
		expect(c?.body).toBe('b');
		expect(c?.addressed?.note).toBe('trimmed');
		expect(c?.addressed?.original).toBe(original);
	});

	it('ignores an [addressed ...] line inside a NON-adjacent original', () => {
		const original = '[addressed amy 2024-01-01]: n';
		const c = parseAll(
			[
				'<!-- annoteca/note: b',
				'[id=abcd1234]',
				'[addressed claude 2026-06-20]: trimmed',
				'',
				'```annoteca-original',
				original,
				'```',
				'-->',
			].join('\n'),
		)[0];
		expect(c?.id).toBe('abcd1234');
		expect(c?.addressed?.original).toBe(original);
	});

	it('absorbs a format example that ends a body, and loses no characters doing it', () => {
		// Pinned, not accidental. A body whose LAST lines quote the format is
		// byte-identical to a real addressed note, so it is absorbed and the
		// comment gains an addressed state it did not mean. Every released
		// version has done this; the alternative is requiring adjacency, which
		// destroys real markers instead. The characters all survive, so the
		// misread is recoverable by editing and the alternative is not.
		const input = [
			'<!-- annoteca/note: here is what one looks like',
			'[addressed amy 2024-01-01]: n',
			'',
			'```annoteca-original',
			'old text',
			'```',
			'[id=abcd1234]',
			'-->',
		].join('\n');
		const c = parseAll(input)[0];
		expect(c?.body).toBe('here is what one looks like');
		expect(c?.addressed?.original).toBe('old text');

		const squeeze = (s: string): string =>
			s
				.slice(s.indexOf(':') + 1, s.lastIndexOf('-->'))
				.replace(/[\s`]/g, '')
				.split('')
				.sort()
				.join('');
		expect(c).toBeDefined();
		if (c) expect(squeeze(serialize(c))).toBe(squeeze(input));
	});

	it('keeps the example when ordinary prose follows it', () => {
		// One line of prose after the quote is enough: the walk stops there,
		// reports no addressed note, and the strip is thrown away.
		const c = parseAll(
			[
				'<!-- annoteca/note: here is what one looks like',
				'[addressed amy 2024-01-01]: n',
				'',
				'```annoteca-original',
				'old text',
				'```',
				'clear?',
				'[id=abcd1234]',
				'-->',
			].join('\n'),
		)[0];
		expect(c?.id).toBe('abcd1234');
		expect(c?.addressed).toBeUndefined();
		expect(c?.body).toContain('```annoteca-original\nold text\n```');
	});

	it('round-trips a non-adjacent fence back to the canonical adjacent form', () => {
		const c = parseAll(marker('', '[reply bob 2026-06-21]: hi'))[0];
		expect(c).toBeDefined();
		if (!c) return;
		const rewritten = serialize(c);
		expect(rewritten).toContain(
			'[addressed claude 2026-06-20]: Cut the framing.\n```annoteca-original\nthe old sentence\n```',
		);
		const again = parseAll(rewritten)[0];
		expect(again?.addressed?.original).toBe('the old sentence');
		expect(serialize(again as Comment)).toBe(rewritten);
	});
});

// ---------------------------------------------------------------------------
// PR A item 4: body lines that mimic a structured trailing line.
//
// serialize() emits the body raw and the walk reads bottom-up, so a comment
// whose text quotes the format meets its own quote on the way back in. Every
// repro below was executed against the shipped parser in the 2026-08-04 review.
// ---------------------------------------------------------------------------

describe('parser: body lines that mimic structured lines', () => {
	it('keeps the real id and leaves an [id=...] mimic in the body', () => {
		const text = serialize({
			id: 'realid12',
			category: 'note',
			body: 'see the marker line:\n[id=deadbeef]',
		});
		const c = parseAll(text)[0];
		expect(c).toBeDefined();
		if (!c) return;
		// Before the fix the body-side line won, so the comment came back
		// carrying deadbeef: every star, draft and re-lookup keyed on realid12
		// dangled, and the next write rewrote the wrong marker.
		expect(c.id).toBe('realid12');
		expect(c.body).toBe('see the marker line:\n[id=deadbeef]');
		// And it must not walk further on the next pass.
		const again = parseAll(serialize(c))[0];
		expect(again?.id).toBe('realid12');
		expect(again?.body).toBe('see the marker line:\n[id=deadbeef]');
		expect(serialize(again as Comment)).toBe(serialize(c));
	});

	it('keeps the real date and leaves a [date=...] mimic in the body', () => {
		const text = serialize({
			id: 'realid12',
			category: 'note',
			body: 'stamped like this:\n[date=2020-01-01]',
			date: '2026-08-04T09:00:00',
		});
		const c = parseAll(text)[0];
		expect(c?.date).toBe('2026-08-04T09:00:00');
		expect(c?.body).toBe('stamped like this:\n[date=2020-01-01]');
	});

	it('keeps the real author and leaves an [author=...] mimic in the body', () => {
		const text = serialize({
			id: 'realid12',
			category: 'note',
			body: 'attributed like this:\n[author=someone]',
			author: 'charles',
		});
		const c = parseAll(text)[0];
		expect(c?.author).toBe('charles');
		expect(c?.body).toBe('attributed like this:\n[author=someone]');
	});

	it('keeps the real anchor and leaves an [anchor=...] mimic in the body', () => {
		const text = serialize({
			id: 'realid12',
			category: 'note',
			body: 'anchored like this:\n[anchor=whatever]',
			anchor: { text: 'the real anchor', truncated: false },
		});
		const c = parseAll(text)[0];
		expect(c?.anchor?.text).toBe('the real anchor');
		expect(c?.body).toBe('anchored like this:\n[anchor=whatever]');
	});

	it('still round-trips a full tail exactly', () => {
		const text = serialize({
			id: 'fulltail',
			category: 'tone',
			body: 'the body',
			date: '2026-08-01T10:00:00',
			author: 'charles',
			anchor: { text: 'anchored words', truncated: false },
			replies: [
				{ author: 'ai', date: '2026-08-01T10:05:00', body: 'first' },
				{
					author: 'charles',
					date: '2026-08-01T10:06:00',
					body: 'second',
				},
			],
			addressed: {
				author: 'ai',
				date: '2026-08-01T10:07:00',
				note: 'applied',
				original: 'the old sentence',
			},
			resolution: {
				author: 'charles',
				date: '2026-08-01T10:08:00',
				note: 'good',
			},
		});
		const c = parseAll(text)[0];
		expect(c).toBeDefined();
		if (!c) return;
		expect(c.id).toBe('fulltail');
		expect(c.body).toBe('the body');
		expect(c.date).toBe('2026-08-01T10:00:00');
		expect(c.author).toBe('charles');
		expect(c.anchor?.text).toBe('anchored words');
		expect(c.replies.map((r) => r.body)).toEqual(['first', 'second']);
		expect(c.addressed?.original).toBe('the old sentence');
		expect(c.resolution?.note).toBe('good');
		expect(serialize(c)).toBe(text);
	});

	it('documents the irreducible case: an id-less marker adopts the mimic', () => {
		// No real [id=...] line to prefer, so the body-side one is the only
		// candidate and the walk takes it. Nothing in the text distinguishes the
		// two. Pinned so a future change to the walk has to argue with it.
		const text = serialize({
			category: 'note',
			body: 'quotes the format:\n[id=deadbeef]',
		});
		const c = parseAll(text)[0];
		expect(c?.id).toBe('deadbeef');
		expect(c?.body).toBe('quotes the format:');
	});
});

// ---------------------------------------------------------------------------
// PR A item 5: author tokens.
// ---------------------------------------------------------------------------

describe('parser: serialize sanitizes author tokens', () => {
	it('survives a resolution author with a space', () => {
		// Executed failure: `[resolved Charles Kelsoe ...]` matches neither the
		// resolved pattern nor the forward-compat shapes, so the walk broke on it
		// and the whole trailing block above it collapsed into the body. The
		// comment lost its id, its thread and its resolution in one write.
		const text = serialize({
			id: 'authr001',
			category: 'note',
			body: 'body text',
			replies: [{ author: 'ai', date: '2026-08-01', body: 'a reply' }],
			resolution: {
				author: 'Charles Kelsoe',
				date: '2026-08-02',
				note: 'done',
			},
		});
		const c = parseAll(text)[0];
		expect(c).toBeDefined();
		if (!c) return;
		expect(c.id).toBe('authr001');
		expect(c.replies).toHaveLength(1);
		expect(c.resolution?.author).toBe('Charles-Kelsoe');
		expect(c.body).toBe('body text');
	});

	it('survives an author token containing the terminator', () => {
		const text = serialize({
			id: 'authr002',
			category: 'note',
			body: 'body text',
			author: 'ai-->bot',
			replies: [{ author: 'ai-->bot', date: '2026-08-01', body: 'hi' }],
		});
		// The marker must still be closed exactly once, and the reply must
		// survive: `-->` in the author line used to end the HTML comment early
		// and spill the rest into the document.
		expect(parseAll(text)).toHaveLength(1);
		const c = parseAll(text)[0];
		expect(c?.author).toBe('ai--bot');
		expect(c?.replies[0]?.body).toBe('hi');
		expect(c?.marker.end).toBe(text.length);
	});

	it('truncates a 33-character token to 32 and round-trips it', () => {
		const long = 'z'.repeat(33);
		const text = serialize({
			id: 'authr003',
			category: 'note',
			body: 'body text',
			author: long,
		});
		const c = parseAll(text)[0];
		expect(c?.author).toBe('z'.repeat(32));
		expect(serialize(c as Comment)).toBe(text);
	});

	it('does not throw on an author value that is not a string', () => {
		// data.json is untyped at runtime: a hand edit or a synced backup can
		// make authorTag a number or null, and it reaches serialize through the
		// composer without passing a type check. Throwing here would take the
		// whole write with it, which is worse than the malformed line the
		// sanitizer exists to prevent.
		const text = serialize({
			id: 'authr005',
			category: 'note',
			body: 'body text',
			author: 42 as unknown as string,
		});
		expect(parseAll(text)).toHaveLength(1);
		expect(parseAll(text)[0]?.author).toBe('42');
		expect(parseAll(text)[0]?.body).toBe('body text');
	});

	it('falls back to `user` for a token that sanitizes to nothing', () => {
		const text = serialize({
			id: 'authr004',
			category: 'note',
			body: 'body text',
			author: '   ',
		});
		expect(text).toContain('[author=user]');
		expect(parseAll(text)[0]?.author).toBe('user');
	});
});

// ---------------------------------------------------------------------------
// PR A item 6: anchors at any length.
// ---------------------------------------------------------------------------

describe('parser: anchor round trip', () => {
	it('keeps a 201-character anchor, truncated, through a lifecycle rewrite', () => {
		// The parser pattern used to cap the value at 200 characters, so a longer
		// one fell through to the unknown-line shape, was absorbed, and vanished
		// on the next write. Nothing enforced the cap on the way out.
		const long = 'a'.repeat(201);
		const text = serialize({
			id: 'anchr001',
			category: 'note',
			body: 'body text',
			anchor: { text: long, truncated: false },
		});
		const c = parseAll(text)[0];
		expect(c).toBeDefined();
		if (!c) return;
		expect(c.anchor).toBeDefined();
		expect(c.anchor?.text.length).toBeLessThanOrEqual(200);
		expect(c.anchor?.truncated).toBe(true);
		expect(serialize(c)).toBe(text);
	});

	it('parses an over-long anchor line already in a file, instead of eating it', () => {
		// This is the half serialize() cannot cover. A marker that arrived from
		// a hand edit, an assistant, or a build with no serialize-time cap can
		// hold a value longer than the old 200-character pattern allowed. It
		// then matched the unknown-line shape instead, which ABSORBS the line and
		// drops it, so the anchor was deleted on the next rewrite with nothing to
		// show the user. Forward-compatible parsing is what the pattern's own
		// comment promised.
		const long = 'b'.repeat(250);
		const text = [
			'<!-- annoteca/note: body text',
			'[id=anchr005]',
			`[anchor=${long}]`,
			'-->',
		].join('\n');
		const c = parseAll(text)[0];
		expect(c).toBeDefined();
		if (!c) return;
		expect(c.anchor?.text).toBe(long);
		expect(c.body).toBe('body text');
		expect(c.id).toBe('anchr005');
		// And the next write brings it inside the cap rather than losing it.
		const rewritten = parseAll(serialize(c))[0];
		expect(rewritten?.anchor).toBeDefined();
		expect(rewritten?.anchor?.text.length).toBeLessThanOrEqual(200);
	});

	it('treats [anchor=] as an empty structured line, not an anchor', () => {
		const text = [
			'<!-- annoteca/note: body text',
			'[id=anchr002]',
			'[anchor=]',
			'-->',
		].join('\n');
		const c = parseAll(text)[0];
		expect(c?.anchor).toBeUndefined();
		// And it does not eat the body line above it.
		expect(c?.body).toBe('body text');
	});

	it('skips the anchor line entirely for a blank anchor', () => {
		const text = serialize({
			id: 'anchr003',
			category: 'note',
			body: 'body text',
			anchor: { text: '   ', truncated: false },
		});
		expect(text).not.toContain('[anchor=');
		expect(parseAll(text)[0]?.anchor).toBeUndefined();
	});

	it('strips a bracket from the anchor so the line stays parseable', () => {
		const text = serialize({
			id: 'anchr004',
			category: 'note',
			body: 'body text',
			anchor: { text: 'bracket ] inside', truncated: false },
		});
		const c = parseAll(text)[0];
		expect(c?.anchor?.text).toBe('bracket  inside');
		expect(c?.body).toBe('body text');
		expect(c?.id).toBe('anchr004');
	});
});

// ---------------------------------------------------------------------------
// PR A item 7: an unclosed opener is visible.
// ---------------------------------------------------------------------------

describe('parser: findMalformedMarkers sees unclosed openers', () => {
	const MERGED = [
		'<!-- annoteca/clarify: first comment',
		'[id=mrg00001]',
		'',
		'Prose that is about to disappear.',
		'',
		'<!-- annoteca/tone: second comment',
		'[id=mrg00002]',
		'-->',
	].join('\n');

	it('still merges the two markers, which is pinned rather than endorsed', () => {
		// Current behaviour: MARKER_RE pairs the first opener with the second
		// marker's terminator, so the prose between them becomes inner content
		// and the second comment disappears. Whether that should refuse to merge
		// is a format question with its own ambiguity, so parsing is unchanged
		// here and this assertion exists to make any future change deliberate.
		const comments = parseAll(MERGED);
		expect(comments).toHaveLength(1);
		expect(comments[0]?.category).toBe('clarify');
		expect(comments[0]?.id).toBe('mrg00002');
	});

	it('reports the containing marker as a possible merge', () => {
		const found = findMalformedMarkers(MERGED);
		expect(found.map((f) => f.kind)).toContain('possible-merge');
		const merge = found.find((f) => f.kind === 'possible-merge');
		expect(merge?.start).toBe(0);
	});

	it('reports a lone unclosed opener', () => {
		const text = [
			'Some prose.',
			'',
			'<!-- annoteca/clarify: this one was never closed',
			'[id=unc00001]',
			'',
			'More prose.',
		].join('\n');
		expect(parseAll(text)).toHaveLength(0);
		const found = findMalformedMarkers(text);
		expect(found).toHaveLength(1);
		expect(found[0]?.kind).toBe('unclosed-opener');
	});

	it('reports an unclosed opener that sits mid-line after prose', () => {
		// Markers lead the text they concern, so most of them in a real vault
		// sit after prose rather than in column zero. Anchoring the scan to a
		// line start missed exactly the shape this diagnostic exists to catch.
		const text = [
			'Some prose. <!-- annoteca/clarify: this one was never closed',
			'[id=inl00001]',
			'',
			'More prose.',
		].join('\n');
		expect(parseAll(text)).toHaveLength(0);
		const found = findMalformedMarkers(text);
		expect(found).toHaveLength(1);
		expect(found[0]?.kind).toBe('unclosed-opener');
	});

	it('reports a merge where both markers sit mid-line', () => {
		const text = [
			'First. <!-- annoteca/clarify: first comment',
			'[id=inl00002]',
			'',
			'Prose that is about to disappear.',
			'',
			'Second. <!-- annoteca/tone: second comment',
			'[id=inl00003]',
			'-->',
		].join('\n');
		expect(parseAll(text)).toHaveLength(1);
		const found = findMalformedMarkers(text);
		expect(found.map((f) => f.kind)).toContain('possible-merge');
	});

	it('says nothing about a well-formed document', () => {
		const text = [
			'Prose. <!-- annoteca/tone: fine -->',
			'',
			'<!-- annoteca/clarify: also fine',
			'[id=ok000001]',
			'-->',
		].join('\n');
		expect(findMalformedMarkers(text)).toEqual([]);
	});
});
