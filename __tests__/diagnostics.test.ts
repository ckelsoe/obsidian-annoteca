import {
	detectMarkerConflicts,
	isNamespacePrefix,
	detectOrphans,
	detectStoreOrphans,
	MarkerDamageReporter,
	validateMarkers,
} from '../diagnostics';
import { serializeLeanMarker, type MalformedMarker } from '../parser';
import {
	encodeStoreEntry,
	writeStoreRegion,
	type StoredComment,
} from '../store';

describe('detectMarkerConflicts', () => {
	it('flags non-annoteca namespaced HTML comments', () => {
		const text = `Some text. <!-- annoteca/tone: ok -->
<!-- other-tool/foo: bar -->
<!-- third-party/baz: qux -->`;
		const findings = detectMarkerConflicts(text, 'note.md');
		const prefixes = findings.map((f) => f.prefix).sort();
		expect(prefixes).toEqual(['other-tool', 'third-party']);
	});

	it('does not flag annoteca itself', () => {
		const text = `<!-- annoteca/tone: ok -->`;
		expect(detectMarkerConflicts(text, 'note.md')).toHaveLength(0);
	});

	it('suppresses an allowlisted namespace and keeps the rest', () => {
		const text = `<!-- other-tool/foo: bar -->
<!-- third-party/baz: qux -->`;
		const findings = detectMarkerConflicts(text, 'note.md', ['other-tool']);
		expect(findings.map((f) => f.prefix)).toEqual(['third-party']);
	});

	it('treats an absent allowlist as the previous behaviour', () => {
		const text = `<!-- other-tool/foo: bar -->`;
		expect(detectMarkerConflicts(text, 'note.md')).toEqual(
			detectMarkerConflicts(text, 'note.md', []),
		);
	});

	// The allowlist matches the prefix the scan captured, so an entry carrying
	// the surrounding syntax matches nothing. Pinned because it is the shape a
	// user copying out of the report is most likely to paste, and the settings
	// field rejects it up front rather than storing a dead entry.
	it('does not match an entry carrying marker syntax', () => {
		const text = `<!-- other-tool/foo: bar -->`;
		expect(
			detectMarkerConflicts(text, 'note.md', ['other-tool/']),
		).toHaveLength(1);
	});
});

describe('isNamespacePrefix', () => {
	it('accepts the shape the scan captures', () => {
		expect(isNamespacePrefix('plumbline')).toBe(true);
		expect(isNamespacePrefix('other-tool')).toBe(true);
		expect(isNamespacePrefix('a1')).toBe(true);
	});

	it('rejects what the scan can never produce', () => {
		expect(isNamespacePrefix('')).toBe(false);
		expect(isNamespacePrefix('Plumbline')).toBe(false);
		expect(isNamespacePrefix('1tool')).toBe(false);
		expect(isNamespacePrefix('plumbline/')).toBe(false);
		expect(isNamespacePrefix('two words')).toBe(false);
	});
});

describe('detectOrphans', () => {
	it('identifies a comment alone on its line between two blank lines', () => {
		const text = `Paragraph one.

<!-- annoteca/tone: floating -->

Paragraph two.`;
		const orphans = detectOrphans(text, 'note.md');
		expect(orphans).toHaveLength(1);
	});

	it('does not flag a comment attached to prose', () => {
		const text = `Paragraph one. <!-- annoteca/tone: ok -->\n\nParagraph two.`;
		expect(detectOrphans(text, 'note.md')).toHaveLength(0);
	});

	it('does not flag a comment at end of paragraph', () => {
		const text = `Paragraph one.\n<!-- annoteca/tone: ok -->\nNext line of paragraph.`;
		expect(detectOrphans(text, 'note.md')).toHaveLength(0);
	});

	it('does not flag an addressed comment even when it sits alone (F-272)', () => {
		// An addressed comment may legitimately sit on its own line between blanks
		// (the AI replaced the surrounding prose). That is an expected pending
		// state, not an accidental orphan.
		const text = [
			'Paragraph one.',
			'',
			'<!-- annoteca/clarify: tighten this',
			'[id=addr0001]',
			'[addressed claude 2026-06-20]: replaced the passage',
			'```annoteca-original',
			'the old passage',
			'```',
			'-->',
			'',
			'Paragraph two.',
		].join('\n');
		expect(detectOrphans(text, 'note.md')).toHaveLength(0);
	});
});

describe('detectStoreOrphans', () => {
	const entry: StoredComment = {
		id: 'store001',
		category: 'clarify',
		body: 'which products?',
		replies: [],
	};

	it('flags a store entry with no marker as an orphaned entry', () => {
		// The marker and its prose were deleted; the entry is stranded at EOF.
		const content = `Prose with no markers.\n\n${encodeStoreEntry(entry)}`;
		const findings = detectStoreOrphans(content, 'note.md');
		expect(findings).toHaveLength(1);
		expect(findings[0]).toMatchObject({
			kind: 'orphaned-store-entry',
			id: 'store001',
			category: 'clarify',
			body: 'which products?',
		});
	});

	it('flags a lean marker with no entry as a dangling marker', () => {
		const content = `Prose. ${serializeLeanMarker('clarify', 'gone0001')}`;
		const findings = detectStoreOrphans(content, 'note.md');
		expect(findings).toHaveLength(1);
		expect(findings[0]).toMatchObject({
			kind: 'dangling-lean-marker',
			id: 'gone0001',
			category: 'clarify',
			body: '',
		});
	});

	it('is silent for a healthy eof note (marker joined to its entry)', () => {
		const content = writeStoreRegion(
			`Prose. ${serializeLeanMarker(entry.category, entry.id)}`,
			[entry],
		);
		expect(detectStoreOrphans(content, 'note.md')).toEqual([]);
	});

	it('is silent for an inline-only file (no store, non-lean markers)', () => {
		const content =
			'Prose. <!-- annoteca/tone: has a body\n[id=inline01]\n-->';
		expect(detectStoreOrphans(content, 'note.md')).toEqual([]);
	});

	it('reports both directions in one file', () => {
		const content = writeStoreRegion(
			[
				`A. ${serializeLeanMarker('clarify', 'store001')}`,
				`B. ${serializeLeanMarker('cut', 'dangling')}`,
			].join('\n\n'),
			[entry, { ...entry, id: 'stranded', body: 'stranded body' }],
		);
		const kinds = detectStoreOrphans(content, 'note.md')
			.map((f) => `${f.kind}:${f.id}`)
			.sort();
		expect(kinds).toEqual([
			'dangling-lean-marker:dangling',
			'orphaned-store-entry:stranded',
		]);
	});
});

describe('validateMarkers', () => {
	it('reports malformed marker openings', () => {
		const text = `<!-- annoteca/TONE: bad uppercase -->`;
		const findings = validateMarkers(text, 'note.md');
		expect(findings.length).toBeGreaterThan(0);
	});

	it('returns empty for clean content', () => {
		const text = `<!-- annoteca/tone: body --> and <!-- annoteca/cut: body -->`;
		expect(validateMarkers(text, 'note.md')).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// PR A item 7, the surfacing half. The detector is old; nothing asked it.
// ---------------------------------------------------------------------------

describe('MarkerDamageReporter', () => {
	const damage = (reason: string): MalformedMarker => ({
		start: 0,
		excerpt: '<!-- annoteca/todo: never closed',
		reason,
		kind: 'unclosed-opener',
	});

	it('reports the finding, quoting the detector rather than restating it', () => {
		const r = new MarkerDamageReporter();
		const notice = r.report('a.md', 'A', [damage('Opener has no close.')]);
		expect(notice).toContain('A');
		expect(notice).toContain('Opener has no close.');
		expect(notice).toContain('Validate marker format');
	});

	it('says nothing at all for a clean note', () => {
		const r = new MarkerDamageReporter();
		expect(r.report('a.md', 'A', [])).toBeUndefined();
	});

	it('reports a note once per session, not on every rebuild', () => {
		// Rebuilds fire on open and on every save, so the same finding arrives
		// repeatedly while the user works. Without this the note produces a
		// Notice per keystroke-save and the warning becomes noise.
		const r = new MarkerDamageReporter();
		const findings = [damage('Opener has no close.')];
		expect(r.report('a.md', 'A', findings)).toBeDefined();
		expect(r.report('a.md', 'A', findings)).toBeUndefined();
		expect(r.report('a.md', 'A', findings)).toBeUndefined();
	});

	it('reports each note separately', () => {
		const r = new MarkerDamageReporter();
		const findings = [damage('Opener has no close.')];
		expect(r.report('a.md', 'A', findings)).toBeDefined();
		expect(r.report('b.md', 'B', findings)).toBeDefined();
	});

	it('warns again after the note comes back clean and breaks a second time', () => {
		// Otherwise the once-per-session rule swallows damage introduced later
		// in the same session, which is the case the user most needs told.
		const r = new MarkerDamageReporter();
		const findings = [damage('Opener has no close.')];
		expect(r.report('a.md', 'A', findings)).toBeDefined();
		expect(r.report('a.md', 'A', [])).toBeUndefined();
		expect(r.report('a.md', 'A', findings)).toBeDefined();
	});

	it('counts the rest rather than listing them', () => {
		const r = new MarkerDamageReporter();
		const notice = r.report('a.md', 'A', [
			damage('First problem.'),
			damage('Second problem.'),
			damage('Third problem.'),
		]);
		expect(notice).toContain('First problem.');
		expect(notice).toContain('2 more');
		expect(notice).not.toContain('Second problem.');
	});

	it('carries the warning across a rename, and frees the old path', () => {
		// A renamed note is the same note, so it must not warn twice, and the
		// old path must not sit in the set keeping a genuinely new note there
		// quiet for the rest of the session.
		const r = new MarkerDamageReporter();
		const findings = [damage('Opener has no close.')];
		expect(r.report('a.md', 'A', findings)).toBeDefined();
		r.rename('a.md', 'b.md');
		expect(r.report('b.md', 'B', findings)).toBeUndefined();
		expect(r.report('a.md', 'A', findings)).toBeDefined();
	});

	it('leaves an unwarned note unwarned when it is renamed', () => {
		const r = new MarkerDamageReporter();
		const findings = [damage('Opener has no close.')];
		r.rename('a.md', 'b.md');
		expect(r.report('b.md', 'B', findings)).toBeDefined();
	});

	it('forgets a deleted note, so a new one at that path is not silent', () => {
		const r = new MarkerDamageReporter();
		const findings = [damage('Opener has no close.')];
		expect(r.report('a.md', 'A', findings)).toBeDefined();
		r.forget('a.md');
		expect(r.report('a.md', 'A', findings)).toBeDefined();
	});
});

describe('validateMarkers surfaces what the index now carries', () => {
	it('finds an unclosed opener in the ledger M1 document', () => {
		const text = [
			'<!-- annoteca/todo: first comment',
			'[id=aaaaaaaa]',
			'',
			'This is real prose that the reader must see.',
			'',
			'<!-- annoteca/question: second comment',
			'[id=bbbbbbbb]',
			'-->',
		].join('\n');
		const found = validateMarkers(text, 'note.md');
		expect(found.map((f) => f.kind)).toEqual(['unclosed-opener']);
		expect(found[0]?.path).toBe('note.md');
	});
});
