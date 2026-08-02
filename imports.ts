// Import helpers (F-221, F-222, F-230). Pure conversion utilities; commands
// in main.ts wrap these with backup-confirmation modals and bulk vault writes.

// Match `%%text%%` Obsidian native comments. Non-greedy, multiline.
const NATIVE_COMMENT_RE = /%%([\s\S]*?)%%/g;

// Match `<!-- text -->` HTML comments. Non-greedy, multiline.
const HTML_COMMENT_RE = /<!--([\s\S]*?)-->/g;

export interface ImportResult {
	updated: string;
	converted: number;
}

// Shared replacement engine for both comment syntaxes. The regex picks the
// source format; `skip` lets a format leave specific matches untouched (the
// HTML pass must not re-convert markers already in the annoteca format).
function convertComments(
	content: string,
	category: string,
	pattern: RegExp,
	skip?: (body: string) => boolean,
): ImportResult {
	let converted = 0;
	const updated = content.replace(pattern, (full, body: string) => {
		if (skip?.(body)) return full;
		converted += 1;
		const cleaned = body.trim().replace(/\n+/g, ' ');
		return `<!-- annoteca/${category}: ${cleaned} -->`;
	});
	return { updated, converted };
}

export function convertNativeComments(
	content: string,
	category: string,
): ImportResult {
	return convertComments(content, category, NATIVE_COMMENT_RE);
}

export function convertGenericHtmlComments(
	content: string,
	category: string,
): ImportResult {
	// Skip markers that already follow the annoteca format.
	return convertComments(content, category, HTML_COMMENT_RE, (body) =>
		/^\s*annoteca\//.test(body),
	);
}

export type ImportFormat = 'native' | 'html' | 'all';

export function convertAllComments(
	content: string,
	format: ImportFormat,
	category: string,
): ImportResult {
	if (format === 'native') return convertNativeComments(content, category);
	if (format === 'html') return convertGenericHtmlComments(content, category);
	const first = convertNativeComments(content, category);
	const second = convertGenericHtmlComments(first.updated, category);
	return {
		updated: second.updated,
		converted: first.converted + second.converted,
	};
}
