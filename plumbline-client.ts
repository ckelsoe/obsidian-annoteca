// Reading Plumbline's findings, per interop-contract section 6.
//
// Annoteca is the consumer here. Everything below narrows a shape that belongs
// to another plugin and another repo, so nothing is trusted: a missing plugin,
// an old version, a renamed field or a thrown error all resolve to "no
// findings", never to a broken lane.
//
// Resolved at CALL time and never held (contract 4.5). A handle kept across
// Plumbline's reload points at a dead plugin instance.

// The version this consumer understands. Higher means Plumbline has changed the
// shape and this build cannot know how, so the lane hides rather than guessing,
// which is the degrade-on-unknown-version rule in contract 7.
export const SUPPORTED_PLUMBLINE_API = 1;

export type FindingSeverity = 'error' | 'warning' | 'suggestion';

export interface FindingOccurrence {
	start: number;
	end: number;
	key: string;
}

export interface PlumblineFinding {
	key: string;
	ruleSlug: string;
	packId: string;
	severity: FindingSeverity;
	message: string;
	occurrences: readonly FindingOccurrence[];
	confidence: number;
	priority: number;
	rolledUp: boolean;
}

export interface PlumblineApiHandle {
	findingsFor(path: string): Promise<readonly PlumblineFinding[]>;
	onFindingsChanged(cb: (path: string) => void): () => void;
	activeProfile(path: string): string;
}

function isSeverity(value: unknown): value is FindingSeverity {
	return value === 'error' || value === 'warning' || value === 'suggestion';
}

function asOccurrence(value: unknown): FindingOccurrence | null {
	if (typeof value !== 'object' || value === null) return null;
	const o: Record<string, unknown> = { ...value };
	if (typeof o.start !== 'number' || typeof o.end !== 'number') return null;
	return {
		start: o.start,
		end: o.end,
		// A key is required to promote (it is the idempotency key), but a
		// finding is still worth SHOWING without one. Missing becomes empty and
		// the row's promote action is what checks it.
		key: typeof o.key === 'string' ? o.key : '',
	};
}

// One finding, or null if it is not one. Exported because the narrowing is the
// part worth testing: it is the whole defence against another plugin's shape
// changing under this one.
export function asFinding(value: unknown): PlumblineFinding | null {
	if (typeof value !== 'object' || value === null) return null;
	const f: Record<string, unknown> = { ...value };
	if (typeof f.ruleSlug !== 'string' || f.ruleSlug === '') return null;
	if (!isSeverity(f.severity)) return null;
	if (typeof f.message !== 'string') return null;
	if (!Array.isArray(f.occurrences)) return null;
	const occurrences = f.occurrences
		.map(asOccurrence)
		.filter((o): o is FindingOccurrence => o !== null);
	// A finding with nowhere to point is not showable: every row in the lane
	// navigates, and one that cannot is a dead row.
	if (occurrences.length === 0) return null;
	return {
		key: typeof f.key === 'string' ? f.key : '',
		ruleSlug: f.ruleSlug,
		packId: typeof f.packId === 'string' ? f.packId : '',
		severity: f.severity,
		message: f.message,
		occurrences,
		confidence: typeof f.confidence === 'number' ? f.confidence : 0,
		// Ranking is Plumbline's, per contract 3.3, so the two surfaces order
		// findings identically. Absent means unranked rather than top-ranked.
		priority: typeof f.priority === 'number' ? f.priority : 0,
		rolledUp: f.rolledUp === true,
	};
}

export function asFindings(value: unknown): PlumblineFinding[] {
	if (!Array.isArray(value)) return [];
	return value
		.map(asFinding)
		.filter((f): f is PlumblineFinding => f !== null);
}

// Whether a resolved plugin object exposes an API this build can talk to.
// Split out from the lookup so the version rule is testable without Obsidian.
export function asApiHandle(plugin: unknown): PlumblineApiHandle | null {
	if (typeof plugin !== 'object' || plugin === null) return null;
	const api: unknown = (plugin as { api?: unknown }).api;
	if (typeof api !== 'object' || api === null) return null;
	const { apiVersion, findingsFor, onFindingsChanged, activeProfile } =
		api as Record<string, unknown>;
	// Unknown or higher means degrade to unpaired behaviour rather than guess.
	if (
		typeof apiVersion !== 'number' ||
		apiVersion !== SUPPORTED_PLUMBLINE_API
	) {
		return null;
	}
	if (
		typeof findingsFor !== 'function' ||
		typeof onFindingsChanged !== 'function' ||
		typeof activeProfile !== 'function'
	) {
		return null;
	}
	return api as unknown as PlumblineApiHandle;
}
