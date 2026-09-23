import { captureSnapshot, detectDrift } from '../drift';
import { parseAll } from '../parser';

describe('drift: captureSnapshot', () => {
	it('captures normalized surrounding text', () => {
		const text = `Some prose before. <!-- annoteca/tone: x --> More prose after.`;
		const c = parseAll(text)[0];
		expect(c).toBeDefined();
		if (!c) return;
		const snap = captureSnapshot(text, c);
		expect(snap.before).toContain('prose before');
		expect(snap.after).toContain('More prose after');
	});
});

describe('drift: detectDrift', () => {
	it('returns no findings on first run', () => {
		const text = `prose <!-- annoteca/tone: x
[id=aaaa1111]
--> end.`;
		const comments = parseAll(text);
		const r = detectDrift(text, 'note.md', comments, {});
		expect(r.findings).toHaveLength(0);
		expect(r.refreshedSnapshots['aaaa1111']).toBeDefined();
	});

	it('flags drift when surrounding text changes', () => {
		const before = `original prose <!-- annoteca/tone: x
[id=aaaa1111]
--> end.`;
		const after = `completely different prose <!-- annoteca/tone: x
[id=aaaa1111]
--> end.`;
		const firstRun = detectDrift(before, 'note.md', parseAll(before), {});
		const secondRun = detectDrift(
			after,
			'note.md',
			parseAll(after),
			firstRun.refreshedSnapshots,
		);
		expect(secondRun.findings).toHaveLength(1);
	});

	it('does not flag when text is unchanged', () => {
		const text = `prose <!-- annoteca/tone: x
[id=aaaa1111]
--> end.`;
		const firstRun = detectDrift(text, 'note.md', parseAll(text), {});
		const secondRun = detectDrift(
			text,
			'note.md',
			parseAll(text),
			firstRun.refreshedSnapshots,
		);
		expect(secondRun.findings).toHaveLength(0);
	});
});

// Baselines taken before the index normalized line endings were captured from
// raw CRLF text at raw offsets. On a note whose lines are short enough that the
// 80-character window spans line breaks, the two captures differ. An unchanged
// note must not report drift on the first check after upgrading.
describe('drift: CRLF baselines from the raw-text basis', () => {
	const lines = Array.from({ length: 12 }, (_, i) => `Line ${i} words.`);
	const lf = `${lines.join('\n')}\nX<!-- annoteca/tone: t\n[id=drift001]\n-->\n${lines.join('\n')}\n`;
	const raw = lf.replace(/\n/g, '\r\n');
	const rawComment = parseAll(raw)[0]!;
	const editorComment = parseAll(lf)[0]!;
	const legacyBaseline = { drift001: captureSnapshot(raw, rawComment) };

	it('the two bases really do capture different windows here', () => {
		expect(captureSnapshot(lf, editorComment)).not.toEqual(
			legacyBaseline.drift001,
		);
	});

	it('refreshes a raw-basis baseline without reporting drift', () => {
		const r = detectDrift(lf, 'n.md', [editorComment], legacyBaseline, {
			content: raw,
			comments: parseAll(raw),
		});
		expect(r.findings).toHaveLength(0);
		expect(r.refreshedSnapshots.drift001).toEqual(
			captureSnapshot(lf, editorComment),
		);
	});

	it('still reports real drift on a CRLF note', () => {
		const movedLf = lf.replace('Line 11 words.\nX', 'Rewritten.\nX');
		const movedRaw = movedLf.replace(/\n/g, '\r\n');
		const r = detectDrift(
			movedLf,
			'n.md',
			parseAll(movedLf),
			legacyBaseline,
			{ content: movedRaw, comments: parseAll(movedRaw) },
		);
		expect(r.findings).toHaveLength(1);
	});
});
