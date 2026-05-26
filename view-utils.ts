// Pure helpers used by the hub panel views. No Obsidian dependency so
// they can be unit-tested without mocking the runtime API.

import type { Comment } from "./types";

export function extractIndexTerm(body: string): string {
	// The modal template emits `<term> > <subterm> — <body>` or `<term> — <body>`.
	// Strip the post-em-dash body if present; return the term/subterm chain.
	const dashIdx = body.indexOf(" — ");
	const head = dashIdx === -1 ? body : body.slice(0, dashIdx);
	return head.trim() || "(unspecified)";
}

export interface HeadingBucket { open: number; resolved: number; }

export interface HeadingShape {
	heading: string;
	level: number;
	position: { start: { offset: number } };
}

export function bucketCommentsByHeading(
	headings: HeadingShape[],
	comments: Comment[],
): HeadingBucket[] {
	const buckets: HeadingBucket[] = headings.map(() => ({ open: 0, resolved: 0 }));
	for (const c of comments) {
		let bucketIdx = -1;
		for (let i = 0; i < headings.length; i++) {
			const h = headings[i];
			if (!h) continue;
			if (h.position.start.offset > c.marker.start) break;
			bucketIdx = i;
		}
		if (bucketIdx === -1) continue;
		const bucket = buckets[bucketIdx];
		if (!bucket) continue;
		if (c.resolution) bucket.resolved += 1;
		else bucket.open += 1;
	}
	return buckets;
}
