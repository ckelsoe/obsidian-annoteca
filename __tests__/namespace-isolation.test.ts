// Contract 4.2 locking test (F-285). Annoteca and Plumbline both write HTML
// comments into the same notes, and Annoteca's marker scans must be blind to
// Plumbline's directives.
//
// This holds by construction today: all three of Annoteca's marker-detecting
// patterns are anchored on the literal `annoteca/`, so a `plumbline:` directive
// cannot match one. It is undefended, though, and that is what this file is for.
// Broadening NAMESPACED_COMMENT_RE, or relaxing the `annoteca/` anchor in
// OPENING_TOKEN_RE or OPENER_ANYWHERE_RE, would start reporting a sibling
// plugin's directives as conflicts or as damage in the user's own vault, and
// nothing else in the suite would notice.
//
// The slash-form control at the bottom is what stops this being a vacuous pass.
// It proves the conflict scan is genuinely looking, so a green run here means
// the isolation holds rather than that the assertions cannot fire.
//
// Deliberately run with an EMPTY allowlist. The allowlist is a user setting and
// a convenience; the isolation is a property of the grammar and must not depend
// on anyone having configured anything.

import { detectMarkerConflicts } from '../diagnostics';
import { findMalformedMarkers } from '../parser';

// Every directive form Plumbline defines, from interop-contract 4.2 and the
// per-file scoping in rollout PL-D. Add to this list whenever Plumbline gains a
// directive; a form that is not listed here is a form nothing pins.
const PLUMBLINE_DIRECTIVES = [
	'<!-- plumbline: off -->',
	'<!-- plumbline: on -->',
	'<!-- plumbline: disable flagged-register -->',
	'<!-- plumbline: enable flagged-register -->',
	'<!-- plumbline-disable -->',
	'<!-- plumbline-enable -->',
];

const DOC = `# Chapter

${PLUMBLINE_DIRECTIVES.join('\n')}

Prose that carries <!-- annoteca/tone: soften this --> a real marker too.
`;

describe('Plumbline directives are invisible to Annoteca marker scans', () => {
	it.each(PLUMBLINE_DIRECTIVES)(
		'%s produces no conflict finding',
		(directive) => {
			expect(detectMarkerConflicts(directive, 'note.md', [])).toEqual([]);
		},
	);

	it.each(PLUMBLINE_DIRECTIVES)(
		'%s produces no malformed-marker finding',
		(directive) => {
			expect(findMalformedMarkers(directive)).toEqual([]);
		},
	);

	it('reports nothing across a document holding every form at once', () => {
		expect(detectMarkerConflicts(DOC, 'note.md', [])).toEqual([]);
		expect(findMalformedMarkers(DOC)).toEqual([]);
	});

	it('still sees the real Annoteca marker in that document', () => {
		// The counterweight to the assertions above: the document is not simply
		// one the scans cannot read.
		const withDamage = DOC.replace(
			'<!-- annoteca/tone: soften this -->',
			'<!-- annoteca/tone: soften this',
		);
		expect(findMalformedMarkers(withDamage).length).toBeGreaterThan(0);
	});

	// The control. A slash form WOULD collide, because it matches the namespace
	// shape the conflict scan looks for. Plumbline must never adopt it, and this
	// asserts the scan would say so if it did.
	//
	// If this test ever fails, the conflict scan has stopped detecting foreign
	// namespaces and every assertion above has become vacuous.
	it('would flag a slash-form directive, so the passes above mean something', () => {
		const findings = detectMarkerConflicts(
			'<!-- plumbline/off -->',
			'note.md',
			[],
		);
		expect(findings.map((f) => f.prefix)).toEqual(['plumbline']);
	});

	it('suppresses that control once plumbline is allowlisted', () => {
		expect(
			detectMarkerConflicts('<!-- plumbline/off -->', 'note.md', [
				'plumbline',
			]),
		).toEqual([]);
	});
});
