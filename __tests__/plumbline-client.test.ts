import {
	SUPPORTED_PLUMBLINE_API,
	asApiHandle,
	asFinding,
	asFindings,
} from '../plumbline-client';

const finding = {
	key: 'f1',
	ruleSlug: 'flagged-register',
	packId: 'base',
	severity: 'warning',
	message: 'Use the plainest word.',
	occurrences: [{ start: 5, end: 13, key: 'o1' }],
	confidence: 0.9,
	priority: 9,
	rolledUp: false,
};

// Everything here narrows a shape owned by another plugin in another repo. A
// renamed field must produce an empty lane, never a broken one.
describe('asFinding', () => {
	it('accepts a well-formed finding', () => {
		expect(asFinding(finding)).toEqual(finding);
	});

	it('rejects anything that is not an object', () => {
		for (const raw of [null, undefined, 42, 'nope', []]) {
			expect(asFinding(raw)).toBe(null);
		}
	});

	it('rejects a finding with no rule', () => {
		expect(asFinding({ ...finding, ruleSlug: '' })).toBe(null);
		expect(asFinding({ ...finding, ruleSlug: 7 })).toBe(null);
	});

	it('rejects an unknown severity', () => {
		expect(asFinding({ ...finding, severity: 'critical' })).toBe(null);
	});

	// Every row in the lane navigates. One that cannot point anywhere is dead.
	it('rejects a finding with nowhere to point', () => {
		expect(asFinding({ ...finding, occurrences: [] })).toBe(null);
		expect(asFinding({ ...finding, occurrences: 'nope' })).toBe(null);
		expect(
			asFinding({ ...finding, occurrences: [{ start: 'a', end: 2 }] }),
		).toBe(null);
	});

	it('drops only the occurrences it cannot read', () => {
		const out = asFinding({
			...finding,
			occurrences: [{ start: 5, end: 13, key: 'o1' }, null, { start: 1 }],
		});
		expect(out?.occurrences).toEqual([{ start: 5, end: 13, key: 'o1' }]);
	});

	// A finding with no key is still worth showing; it just cannot be promoted,
	// which the row's action checks.
	it('keeps a finding whose key is missing, with an empty key', () => {
		const out = asFinding({
			...finding,
			key: undefined,
			occurrences: [{ start: 5, end: 13 }],
		});
		expect(out?.key).toBe('');
		expect(out?.occurrences[0]?.key).toBe('');
	});

	// Absent ranking means unranked. Defaulting high would float a finding
	// Plumbline never ranked to the top of the lane.
	it('treats a missing priority as unranked, not top-ranked', () => {
		expect(asFinding({ ...finding, priority: undefined })?.priority).toBe(
			0,
		);
	});

	it('treats a non-boolean rolledUp as false', () => {
		expect(asFinding({ ...finding, rolledUp: 'yes' })?.rolledUp).toBe(
			false,
		);
	});
});

describe('asFindings', () => {
	it('returns an empty list for anything that is not an array', () => {
		for (const raw of [null, undefined, {}, 'nope']) {
			expect(asFindings(raw)).toEqual([]);
		}
	});

	it('keeps the good entries and drops the rest', () => {
		expect(asFindings([finding, null, { ruleSlug: 'x' }])).toEqual([
			finding,
		]);
	});
});

// Contract 7: unknown or higher means degrade to unpaired behaviour rather than
// guess. The lane hides instead of rendering against a shape it cannot know.
describe('asApiHandle', () => {
	const api = {
		apiVersion: SUPPORTED_PLUMBLINE_API,
		findingsFor: () => Promise.resolve([]),
		onFindingsChanged: () => () => undefined,
		activeProfile: () => 'base',
	};

	it('accepts a matching version with every method', () => {
		expect(asApiHandle({ api })).not.toBe(null);
	});

	it('refuses a plugin that is absent or has no api', () => {
		for (const raw of [null, undefined, 42, {}, { api: null }]) {
			expect(asApiHandle(raw)).toBe(null);
		}
	});

	it('refuses a version it does not understand', () => {
		expect(asApiHandle({ api: { ...api, apiVersion: 2 } })).toBe(null);
		expect(asApiHandle({ api: { ...api, apiVersion: 0 } })).toBe(null);
		expect(asApiHandle({ api: { ...api, apiVersion: '1' } })).toBe(null);
	});

	// A version match is not enough: the methods have to be there, or the first
	// call throws inside a render.
	it('refuses when any method is missing', () => {
		for (const key of [
			'findingsFor',
			'onFindingsChanged',
			'activeProfile',
		]) {
			expect(asApiHandle({ api: { ...api, [key]: undefined } })).toBe(
				null,
			);
		}
	});
});
