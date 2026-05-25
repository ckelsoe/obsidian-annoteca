// Scripture reference auto-formatting (F-251). Rewrites informal references
// like `john 3:16 esv` into canonical `John 3:16 (ESV)`.
//
// Conservative by design: only rewrites when the matched book name is in the
// known set, and only when the translation abbreviation is in the known set.
// Anything ambiguous is left alone.

const KNOWN_BOOKS: ReadonlyArray<string> = [
	"genesis", "exodus", "leviticus", "numbers", "deuteronomy",
	"joshua", "judges", "ruth",
	"1 samuel", "2 samuel", "1 kings", "2 kings",
	"1 chronicles", "2 chronicles",
	"ezra", "nehemiah", "esther", "job", "psalms", "psalm",
	"proverbs", "ecclesiastes", "song of solomon",
	"isaiah", "jeremiah", "lamentations", "ezekiel", "daniel",
	"hosea", "joel", "amos", "obadiah", "jonah", "micah",
	"nahum", "habakkuk", "zephaniah", "haggai", "zechariah", "malachi",
	"matthew", "mark", "luke", "john", "acts", "romans",
	"1 corinthians", "2 corinthians",
	"galatians", "ephesians", "philippians", "colossians",
	"1 thessalonians", "2 thessalonians",
	"1 timothy", "2 timothy",
	"titus", "philemon", "hebrews", "james",
	"1 peter", "2 peter",
	"1 john", "2 john", "3 john",
	"jude", "revelation",
];

const KNOWN_TRANSLATIONS: ReadonlySet<string> = new Set([
	"esv", "niv", "kjv", "nkjv", "nasb", "nlt", "msg",
	"csb", "rsv", "nrsv", "asv", "amp", "tlb", "ceb", "lsb",
]);

function bookCanonical(name: string): string {
	return name
		.split(" ")
		.map(part => part.charAt(0).toUpperCase() + part.slice(1))
		.join(" ");
}

// Patterns recognized:
//   john 3:16
//   john 3:16-18
//   john 3:16 esv
//   1 john 3:16
// The book name is captured as a single word (optionally preceded by 1/2/3
// for the numbered epistles). Multi-word books like "Song of Solomon" are
// not auto-formatted; users can type them in canonical form.
const REFERENCE_RE = /\b((?:[1-3]\s+)?[A-Za-z]+)\s+(\d+):(\d+)(?:-(\d+))?(\s+([A-Za-z]{2,5}))?\b/g;

export function formatScripture(content: string): { updated: string; changes: number } {
	let changes = 0;
	const updated = content.replace(REFERENCE_RE, (
		full,
		book: string,
		chapter: string,
		verse: string,
		range: string | undefined,
		translationTail: string | undefined,
		translation: string | undefined,
	) => {
		const lookupName = book.trim().toLowerCase().replace(/\s+/g, " ");
		if (!KNOWN_BOOKS.includes(lookupName)) return full;
		const canonicalBook = bookCanonical(lookupName);
		const rangePart = range ? `-${range}` : "";
		let result = `${canonicalBook} ${chapter}:${verse}${rangePart}`;
		if (translation) {
			const t = translation.toLowerCase();
			if (KNOWN_TRANSLATIONS.has(t)) {
				result += ` (${t.toUpperCase()})`;
			} else {
				// Captured word isn't a known translation. Treat it as plain
				// prose and keep it in place; still rewrite the reference.
				result += translationTail ?? ` ${translation}`;
			}
		}
		if (result !== full) changes += 1;
		return result;
	});
	return { updated, changes };
}
