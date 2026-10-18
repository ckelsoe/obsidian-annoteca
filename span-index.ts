// Which spans meet a range, answered without comparing every span. Several
// passes ask this once per marker, closer, line or change, and comparing each
// against every span made them quadratic: a note with thousands of comments
// took seconds where it should take milliseconds.
//
// Spans are sorted by start once, so the ones starting before a query's end
// are a prefix found by binary search, and a max tree over their ends finds
// the ones in that prefix reaching past the query's start without visiting
// the rest: a query costs a logarithm per span it returns, however the spans
// nest or overlap.
//
// Pure: no dependencies.

// How many of the first indices of a list hold `holds`, given that it holds
// for a run at the start and then never again: a binary search, shared by
// every lookup that replaced a scan.
export function countWhile(
	length: number,
	holds: (index: number) => boolean,
): number {
	let lo = 0;
	let hi = length;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (holds(mid)) lo = mid + 1;
		else hi = mid;
	}
	return lo;
}

export interface Span {
	start: number;
	end: number;
}

export class SpanIndex<T> {
	private readonly items: T[];
	private readonly starts: number[];
	private readonly ends: number[];
	// A max tree over `ends` in start order: tree[1] covers every item, and
	// node n's children are 2n and 2n + 1. It lets a query skip any run of
	// items none of which reaches its start, so a long span does not make
	// every query walk past all the short ones after it.
	private readonly tree: number[];
	private readonly size: number;

	constructor(items: readonly T[], span: (item: T) => Span) {
		const sorted = items
			.map((item) => ({ item, s: span(item) }))
			.sort((a, b) => a.s.start - b.s.start);
		this.items = sorted.map((x) => x.item);
		this.starts = sorted.map((x) => x.s.start);
		this.ends = sorted.map((x) => x.s.end);
		let size = 1;
		while (size < this.ends.length) size *= 2;
		this.size = size;
		this.tree = new Array<number>(2 * size).fill(-Infinity);
		this.ends.forEach((end, i) => {
			this.tree[size + i] = end;
		});
		for (let n = size - 1; n >= 1; n--)
			this.tree[n] = Math.max(
				this.tree[2 * n] ?? -Infinity,
				this.tree[2 * n + 1] ?? -Infinity,
			);
	}

	// Every item with start < to and end > from, in start order.
	overlapping(from: number, to: number): T[] {
		const out: T[] = [];
		this.collect(1, 0, this.size, this.below(to), from, out);
		return out;
	}

	// The first item in start order with start < to and end > from.
	first(from: number, to: number): T | undefined {
		const i = this.leftmost(1, 0, this.size, this.below(to), from);
		return i === -1 ? undefined : this.items[i];
	}

	// Whether any item has start < to and end > from.
	some(from: number, to: number): boolean {
		return this.reach(1, 0, this.size, this.below(to)) > from;
	}

	// The items in [lo, hi) of node n, before `limit`, whose end passes
	// `from`, appended in order. A node whose largest end does not pass
	// `from` is skipped whole.
	private collect(
		n: number,
		lo: number,
		hi: number,
		limit: number,
		from: number,
		out: T[],
	): void {
		if (lo >= limit || (this.tree[n] ?? -Infinity) <= from) return;
		if (hi - lo === 1) {
			const item = this.items[lo];
			if (item !== undefined) out.push(item);
			return;
		}
		const mid = (lo + hi) >> 1;
		this.collect(2 * n, lo, mid, limit, from, out);
		this.collect(2 * n + 1, mid, hi, limit, from, out);
	}

	// The first item in [lo, hi) of node n, before `limit`, whose end passes
	// `from`, or -1.
	private leftmost(
		n: number,
		lo: number,
		hi: number,
		limit: number,
		from: number,
	): number {
		if (lo >= limit || (this.tree[n] ?? -Infinity) <= from) return -1;
		if (hi - lo === 1) return lo;
		const mid = (lo + hi) >> 1;
		const left = this.leftmost(2 * n, lo, mid, limit, from);
		return left !== -1
			? left
			: this.leftmost(2 * n + 1, mid, hi, limit, from);
	}

	// The largest end among items [lo, hi) of node n that come before `limit`.
	private reach(n: number, lo: number, hi: number, limit: number): number {
		if (lo >= limit) return -Infinity;
		if (hi <= limit) return this.tree[n] ?? -Infinity;
		const mid = (lo + hi) >> 1;
		return Math.max(
			this.reach(2 * n, lo, mid, limit),
			this.reach(2 * n + 1, mid, hi, limit),
		);
	}

	// How many items start before `to`.
	private below(to: number): number {
		const lo = countWhile(
			this.starts.length,
			(mid) => (this.starts[mid] ?? Infinity) < to,
		);
		return lo;
	}
}
