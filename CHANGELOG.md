# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed
- Annoteca now requires Obsidian 1.13.0 or later. The README has said so in three places for a while, but the plugin still declared 1.8.7, so Obsidian offered it to people on older versions who could not run it. Anyone on 1.9 through 1.12 keeps the version they have and stops receiving updates.
- Everything read out of the plugin's settings file is now checked before it is used. That file is editable by hand, arrives over sync, and comes back out of restored backups, so a value in it is not guaranteed to be the kind of value it was saved as. Only a handful of settings were checked before, and the rest were used exactly as found.
- The author tag is cleaned in exactly one place now, where settings are read in, instead of again each time a comment is signed. The second copy of the rule was weaker: a settings file edited by hand to hold something other than text made signing fail with an error, where the settings reader quietly falls back to "user". The exported AI skill built its reviewer line through the same second copy and now reads the cleaned value directly.
- Removing, reordering, or moving a category no longer repaints the category list twice. The extra repaint drew into a copy of the list the settings screen had already discarded, so it was wasted work; what you see is unchanged.

### Added
- "Clear orphaned stars" removes starred comments whose comment no longer exists anywhere in the vault. The Starred tab has always pointed at this command; until now there was no such command, and those stars could not be removed at all.
- Comment bodies, replies, and notes render as Markdown in the marker popover and the Hub panel. The format has always described a comment body as Markdown, and AI assistants write Markdown by default, so the usual result was a comment full of visible asterisks, backticks, and `-` list markers. Links, emphasis, code, lists, quotes, and tables now render, and a `[[wikilink]]` in a comment resolves against the note the comment lives in. There is a "Render Markdown in comments" setting under Editor indicators to turn it off. The one-line body shown beside a marker in the editor stays plain text either way, so turning this on cannot reflow the document you are reading.

### Fixed
- Comment bodies no longer lose their last line when it starts with a bracket. A body ending in a markdown link, a reference definition, a footnote, or an Obsidian `[[wikilink]]` had that line silently deleted the next time the comment was read, because anything shaped like `[...]` at the end of a comment was treated as internal metadata. Only the specific shapes the format actually defines are treated that way now. Existing comments that were already truncated cannot be recovered by this fix; the text was removed from the file when it was last written.
- A comment containing `-->` no longer corrupts the note. That sequence ends the HTML comment the marker lives in, so the marker stopped early, the rest of the body appeared as stray text in the document, and everything after it in the comment was lost. It is now stored escaped and restored on read, so any text can go in a comment, including an arrow. The same fix covers importing: converting an Obsidian `%%comment%%` that contained `-->` used to produce a broken marker, because `%%` comments can hold that sequence quite legally.
- The exported AI skill now teaches assistants to escape `-->`, so an assistant writing a comment directly into a file cannot break the marker. The skill's schema version has gone up, so the plugin will tell you to re-export it with "Export AI skill".
- The exported AI skill now spells out what an author name has to look like and what it costs to get wrong. It gave the shape before but never said that a name the format cannot hold makes the whole line unreadable, so an assistant signing as `Bob Smith` lost the comment's author, or, in a reply, the identifier and the entire thread. It now says to write the name as one word joined with hyphens, and why. Re-export with "Export AI skill" to pick it up; the plugin will prompt you.
- A reply written across two lines no longer destroys the comment. Replies, anchors, and the notes on an addressed or resolved comment are each stored on a single line, and nothing stopped a line break going into one. A reply typed with Enter in it ended the comment's structured section at the break, so the reply, the comment's identifier, and every other detail collapsed into the body as visible text and the thread was gone, taking starring, drafts, and Copy ID with it. The reply box is three lines tall and Enter has always inserted a line break there, and now that replies render as Markdown, writing a list is a natural thing to try. Line breaks in those fields are folded into a single space, so every word survives. Comment bodies and the verbatim original text Reject restores are unaffected and stay multi-line.
- A code block in the text an assistant replaced no longer destroys the comment. When an edit replaces a passage, the original is kept verbatim inside the marker in a fenced block so Reject can put it back. That fence was three backticks, and the captured text is arbitrary prose from your document, so if it contained a code block of its own the fence ended early: the original, the addressed state, and the comment's identifier were all lost, and Reject had nothing left to restore. The fence is now always longer than any run of backticks in the text it holds. Markers written before this change still read normally.
- Writing about the comment format inside a comment no longer deletes what you wrote. A fenced block tagged `annoteca-original` was lifted out of any comment it appeared in, not just the one place the format puts it, so a comment that documented the format by showing an example had those lines silently removed on the next read. The block now counts as stored original text only when it belongs to an `[addressed ...]` note, meaning it sits somewhere after that line. Anywhere else it is prose and stays where you put it.
- A blank line before the stored original text no longer destroys the comment. The block holding the text an edit replaced is written on the line straight after the `[addressed ...]` note, but nothing in the format required that, and a marker written by hand or by an AI assistant often puts a blank line first, or a reply between the two. The comment then lost its identifier and its addressed state, so Accept, Revise and Reject stopped appearing and Reject could no longer put the old wording back, even though it was still sitting in the file. Those markers read correctly now, and the plugin rewrites them into its usual shape the next time it touches them.
- Marking a comment as addressed no longer overwrites someone else's revision. If an assistant, another pane, or a sync marked the same comment as addressed first, the write replaced their note and, with it, the verbatim old text stored for Reject, so the earlier wording could no longer be restored from the file. The action now declines and says the comment is already awaiting review.
- Two comments sharing an identifier no longer send an action to the wrong one. Identifiers live in the note text, so copying a comment inside a note produces two with the same one, and every panel action took the first match whether or not it was the comment on the card. Actions now refuse when the identifier is ambiguous, the way they already refused for a comment with no identifier at all, and say which identifier is duplicated so you can go and change one.
- Long unbroken text in a comment, such as a pasted URL written as plain text, now wraps inside the popover instead of painting past its edge.
- Restoring settings from a backup file now checks the values it reads, the same way loading them does. A backup written by hand or arriving over sync could carry "Render Markdown in comments" as text rather than a true/false value, which read as on however it was written. A value the backup gets wrong now leaves the setting where it was, rather than resetting it.
- A settings file whose category list is not a list no longer stops the plugin loading. Everything that reads the categories walks the list, so a single hand edit or a bad sync that left something else in its place threw on the first read and took the whole load down with it, leaving no comments, no panel, and no settings tab. A settings file that is not a set of settings at all, which a truncated sync can produce, fails the same way and is handled too.
- The default category no longer points at a category that is no longer offered. Turning the index-entry preset off while it supplied the default left the Add comment window opening with nothing selected.
- The Hub panel always draws a tab. An unrecognised value for the last-used tab, which the settings file can hold, drew an empty panel that read as the plugin being broken.
- A comment whose category cannot be written back is no longer made invisible. The category is part of the marker itself, so a category holding a bracket or a line break, which only a hand edit or a sync can produce, wrote a marker the plugin could not find again: the comment vanished from the panel, the editor and every count while its words stayed in the note as ordinary text. Those comments are now written as "uncategorized" and stay readable.
- Dismissing the reply box while a reply is still being written no longer reports a failure for a box that is already gone.
- The Hub's reply box no longer shows a reply that has already been sent. Sending rebuilds the card, and the rebuilt box restored the text from its saved draft before the send had finished clearing it, so the reply came back with the button ready to press again. Pressing it, which is the natural reading of a box that still has your text in it, posted the same reply a second time. The draft is now cleared before the reply is sent, and put back only if the send is refused or fails.
- Hub panel actions no longer discard changes that arrived while you were looking at the card. Resolve, reopen, delete, reply, accept, revise, and reject all wrote back the version of the comment captured when the card was drawn, so a reply landing in between (from an assistant, another pane, or a sync) was silently overwritten. Every action now re-reads the comment immediately before writing, and refuses instead of guessing when the state it was going to act on is gone.
- Importing comments no longer rewrites text inside an existing comment, a code block, or an inline code span. A `%%comment%%` written inside the body of an Annoteca comment was converted where it stood, which put a comment inside a comment: the outer one ended early and the rest of it appeared in the note as visible text. "Import all" hit this every time, because it converts `%%...%%` first. The same pass also converted the examples in a note that documented comment syntax, destroying the sample and counting it as a success. Import now leaves all three kinds of region alone, and running it twice over the same note changes nothing the second time. A code span that runs across a line break counts as one too, which is how Markdown reads it and is a shape that turns up whenever a long snippet is wrapped.
- Editing a comment no longer throws away its addressed state. Saving an edit rebuilt the marker from scratch and left out the `[addressed ...]` note along with the verbatim original text stored beneath it, so Reject quietly became Revise and the wording it was holding was gone from the note. Editing also wrote to the position the comment occupied when the form was opened, so anything that changed the document above it in the meantime, in another pane or over sync, sent the edit to the wrong place. Saving now finds the comment as it currently stands, keeps everything the edit was not about, and says so and stays open rather than writing when the comment can no longer be found.
- Two comment actions running at once no longer lose one of them. Every action read the note, worked out where to write, and then wrote, and two actions overlapping meant the second one was working from a picture of the note taken before the first one finished. Resolving two comments in the same note at the same time silently dropped one of them while reporting both as done. Actions against one note now take their turn, and a write is refused outright if the note changed underneath it, which is what used to splice a `[resolved ...]` line into the middle of a sentence when a sync landed at the wrong moment.
- A comment that quotes the comment format no longer loses its own details. The lines that carry a comment's identifier, date, author, and anchor sit at the end of the marker, and a body ending in a line of that same shape was read as the real thing: a comment whose text ended `[id=...]` came back carrying that identifier instead of its own, which orphaned its star, its draft, and every later action, and the quoted line was deleted from the body. The comment's own line now wins, and the quoted one stays where you wrote it.
- An author name with a space or a bracket in it no longer breaks the comments it is written into. The author tag is written into every comment, reply, and resolution, and nothing checked it, so a tag like `Charles Kelsoe` produced a line the plugin could not read back: the comment lost its identifier, its whole thread, and its resolution on the next write. A tag containing `-->` ended the comment early and spilled the rest into the note. Names are now folded into a form the format can hold (spaces become hyphens) wherever they are written.
- A long anchor is no longer deleted. The anchor records the passage a comment is about, and one longer than the plugin's limit was silently dropped the next time the comment was written, rather than being kept and shortened. Anchors that arrive from a hand edit or an assistant are read at any length now, and shortened rather than removed when the plugin next writes them.
- "Check for problems" now reports a comment whose closing `-->` is missing. Without it, that comment pairs with the NEXT comment's closing tag: everything between them, prose included, is swallowed into one comment, the prose disappears from reading view, and the second comment disappears from the Hub. The document still reads the same way, so this is a report rather than a change in behaviour, but it is now something you can see and fix instead of noticing the missing paragraph much later.
- Deleting or removing a comment now tells you when it failed. If the note was locked, missing, or otherwise unwritable, the action ended in silence with no notice and nothing changed.
- The comment popover and the reply box paint their own frame again. Both were drawing with no background, no border, no padding and no shadow, so a comment appeared as bare text lying on top of the note it was over, and the reply box had nothing keeping it inside the window on a narrow screen.
- Comment popovers now open in the window the note is in. Moving a note to its own window left every marker there with no popover at all, and the reply box, the resolve actions and the star did nothing, because they were being drawn into the main window instead. Opening a note in a separate window while the plugin was loading broke the main window the same way.
- Clicking in the note no longer throws away a reply you were part-way through writing. The reply box was meant to stay put whenever it held text, and only a click on an empty one was meant to dismiss it, but the check looked for the box in the wrong place and never found it, so every click outside took the box away whatever was in it.
- The reply box no longer disappears while you are typing in it. Any edit to the note, including one made in another pane or arriving over sync, threw the box away and rebuilt it, so a half-written reply was lost unless it had been saved as a draft first, and a comment with no identifier never gets a draft. The pinned popover and the highlight on the comment open in the panel were dropped by the same thing. All three now follow the comment as the text around it moves.
- Popover actions now act on the note the popover belongs to. With two notes open side by side, resolving, removing, accepting, revising or rejecting from a popover in the pane you were not focused on was sent to the focused note instead, where it found nothing and told you the comment had moved or been deleted. Replying already worked; the rest now match it.
- A reply sent from a popover is stamped with the time as well as the date, so it no longer jumps above every other reply written the same day.
- Sending a reply when the plugin cannot tell which note it belongs to now says so instead of leaving the Send button doing nothing.
- The Hub's Edit button now edits the note the card is for. Pressing it makes the Hub the active pane, so Edit either refused with "Open the file to edit this comment" while the note was plainly visible, or, with a different note focused, wrote the edit into that one.
- Navigating to a comment no longer opens a second tab for a note that is already open. A tab restored when Obsidian started but never clicked on was not recognised as holding the note, so the tab bar filled up a little more after every restart.
- The Hub panel redraws once per change instead of twice. Starring a comment, changing scope, changing the status filter or switching tabs each rebuilt the panel two times, and on the Thread tab each rebuild walks the vault.
- The Hub's scope dropdown no longer says "This file" while showing something else. With a pinned scope that does not match the note you are on, it now names the scope that is actually in force.
- Closing the Hub's sidebar tab now keeps it closed. It was recreated every time Obsidian started.
- Marker size and anchor appearance settings now apply in separate windows, which were falling back to the defaults and ignoring them.
- The comment text shown beside a marker sits with the line it annotates instead of sagging below it. Thanks to `craziedde` for the report.
- The Add comment window puts the cursor in the body field, so a comment can be written without reaching for the mouse first. Thanks to `craziedde` for the report.

## [1.13.0] - 2026-08-03

### Added
- Markers show how many replies a thread has. The marker icon was a single glyph whatever was behind it, so a one-line note and a twelve-message conversation looked identical until you hovered or clicked. The count now sits beside the icon as a small superscript, and the tooltip spells it out in words. It counts replies, matching the badge on the Hub panel card, and a comment with no replies is unchanged. There is a "Reply count on markers" setting under Editor indicators to turn it off.
- New command, "Toggle inline comment bodies", prints every comment in the document beside the passage it is about. Reading a chapter's feedback previously meant hovering each marker one at a time, or working in the side panel where the comments sit in a separate column from the prose. Bodies are trimmed to a single line so they cannot push the document around, only the first comment is shown and never its replies, and pressing the command again clears them. Both halves of a split view follow the toggle together, the same way "Hide all comments" already does.

### Fixed
- Editor indicator settings now take effect the moment you change them. Indicator style, size, underline style and thickness, resolved-comment display, and the new reply count all wrote the new value correctly but left every open editor drawing the old one, until you happened to click or type in the document. Closing settings and looking at the note was not enough. This was the same underlying cause as the "Hide all comments" delay below, on a wider surface.
- "Hide all comments" now takes effect immediately instead of waiting for the next edit. Running the command flipped the setting but did not repaint the document, so the markers stayed on screen until you happened to type something or move the cursor, at which point they vanished. Turning them back on had the same delay. The visibility state is now something the editor tracks directly, so the toggle redraws on its own.
- "Hide all comments" now applies to every open editor at once. It has always been described as one switch for the whole vault rather than a per-pane setting, but with the document split it only reached the pane you ran it from, so the other side could still be showing markers while the notice said they were hidden.

## [1.12.0] - 2026-08-02

### Added
- A Discord link in the settings footer and the README. Questions, ideas, and general discussion now have somewhere to go that is not a GitHub issue. The invite never expires. A GitHub issue is still the better home for anything that needs tracking.

### Fixed
- The links in the settings footer no longer run together. The separators between them depended on plain whitespace, which the layout dropped, so the row could read `GitHub|Report issues`. They are spaced by the layout now.
- The settings footer no longer wraps a separator onto its own line. When the settings pane is narrow, which is normal in a sidebar you can drag, the row wraps, and each `|` could land at the end or the start of a line away from the link it belongs to. Each separator now travels with its link, so the row only ever breaks between whole entries.

## [1.11.0] - 2026-08-02

### Added
- Accept, Revise, and Reject are reachable without hovering. These three actions decide what happens to an edit an AI assistant has applied, and until now they existed in exactly one place: the popup that appears when you hover a marker. There is no hover on a phone or tablet, so the whole review loop was unreachable there, and anyone working from the side panel could not see or act on it either. They are now also buttons on the comment card in the Hub panel, and three commands ("Accept addressed edit here", "Revise addressed edit here", "Reject addressed edit here") that act on the comment at the cursor, so a hotkey works with no pointer at all.
- The Hub panel shows addressed state. A comment waiting on accept/revise/reject is marked `addressed` on its card, and expanding the card shows who applied the edit and when, the note they left, and the verbatim original text that Reject would restore. The panel previously never displayed this at all, so an addressed comment was indistinguishable from an untouched one.
- Tap or click a marker to open a popover instead of the side panel. New "Clicking a marker" setting under Editor indicators. On phones and tablets it defaults to the popover, because with no hover there was previously no lightweight way to read a comment without opening the sidebar over the document; on desktop it defaults to the existing side-panel behaviour. The popover is the same surface as the hover preview, with the same actions. It closes when you click elsewhere, and it will not close out from under a reply you are part-way through typing.
- Move up and move down buttons on every category row in settings. Category order drives the composer dropdown and the sidebar grouping, but the only way to change it was dragging, and HTML5 drag events never fire on touch, so reordering was impossible on a phone or tablet. The buttons are on every platform rather than being a mobile fallback, because drag-and-drop is equally unusable by keyboard. Focus stays on the row you moved, so you can press the same button repeatedly to walk a category up the list. The drag handle is unchanged on desktop and is now hidden where dragging cannot work, instead of showing a grip that does nothing.
- The expanded category panel now shows the category's identifier. This is the token that appears in the marker itself (`<!-- annoteca/<identifier>: ... -->`), so it is what you need when hand-writing a comment or briefing an AI assistant. Previously it appeared only in the collapsed row, where it is the first thing to run out of room on a narrow screen. It is read-only; changing an identifier would orphan every existing marker using it.

### Fixed
- Rejecting an addressed edit now finds the comment by its identifier before rewriting anything, and refuses to run rather than guess when it cannot. Reject is the only action that rewrites your prose and not just the marker, so acting on an out-of-date position could overwrite the wrong text entirely. Re-running it after the note refreshes works normally. It previously trusted the position recorded when the comment was last read, which is correct when the action comes from the editor but not when it comes from the side panel, where a card can be a moment out of date. If the document had changed above the comment in the meantime, the revert could overwrite the wrong span of text. Every other action already re-resolved; this one did not, and it became reachable the moment Reject was surfaced in the panel.
- The icon picker no longer overflows the screen on a phone. It had a hard 480px minimum width, which is wider than most phone viewports (roughly 390 to 430px), so the modal ran off the edge and scrolled sideways. It now shrinks to fit while keeping the same width on desktop.
- On short screens, typically a phone in landscape, the icon picker's grid no longer pushes its own search field out of view.
- Long category names in settings truncate with an ellipsis instead of wrapping and making the row taller.

## [1.10.1] - 2026-06-22

### Fixed
- The exported AI skill now teaches assistants to stamp comments, replies, addressed marks, and resolutions with the full `YYYY-MM-DDTHH:MM:SS` timestamp instead of a date alone. The thread panel sorts by these stamps on read (added in 1.9.0), and a date-only stamp sorts to the very start of its day, so an AI reply written in the afternoon could jump ahead of a human reply made that morning. The skill schema version is bumped, so any previously exported skill shows as out of date in settings with a prompt to re-export. Re-export the skill (Settings, AI integration) so your assistant picks up the new guidance.

## [1.10.0] - 2026-06-22

### Added
- Collapse and expand individual thread cards. Each comment card has a chevron on the left that toggles whether it is expanded, independent of which card is selected. The selected card still expands by default, but you can now collapse a tall one or keep several open at once, which keeps the right panel manageable on small screens.
- Sync button on each thread card. Click it to scroll the document to that comment's marker, even when the marker is already on screen, so you can pull the document back to the annotation on demand.

### Changed
- New "Marker position when navigating" setting (under Panel and navigation) replaces the old "Center comment when navigating" toggle. Choose where a comment's marker lands when you jump to it: Top of pane (new default, a predictable reading spot), Center, or Minimal (scrolls the least needed and stays put if the marker is already visible). If you had centering turned on, you are migrated to Center; otherwise you get the new Top default.
- Clicking a card in the thread panel now scrolls the document to its marker using your chosen marker position, and selecting a marker in the document scrolls the matching card into view in the panel, so the panel and the document stay in step.

## [1.9.1] - 2026-06-22

### Fixed
- Removed a CSS `:has()` selector flagged by the developer-dashboard scan for selector-invalidation cost. The editor popups (hover preview, reply composer, selection button) drop CodeMirror's default frame the same way as before, via a class on the tooltip element; no visible change.

## [1.9.0] - 2026-06-22

### Added
- Reorder categories by dragging. Each category row in settings now has a drag handle (the grip on the left); drag a row onto another to move it to that position. The category order is what the comment composer's dropdown and the sidebar grouping follow, so this lets you put your most-used categories first. Drag is a desktop affordance (pointer-only).
- Selection comment button (off by default, under Composer). When on, selecting text in the editor shows a floating Comment button next to the selection; click it to open the composer for that range, without the right-click menu. The existing "Add comment here" and "Add comment for selection" commands can also be bound to a hotkey for a keyboard path.
- Marker hover preview controls (under Editor indicators). A "Marker hover preview" toggle turns the on-hover comment preview off if you prefer to open comments by clicking, and a "Hover preview delay" dropdown (instant / short / default / relaxed) tunes the dwell before it appears.

### Changed
- Comments and replies now record the time of day, not just the date. New comments, replies, resolutions, and addressed marks are stamped `YYYY-MM-DDTHH:MM:SS`, and the panel and hover popups show the time alongside the date. Threads stable-sort by timestamp on read, so a fast back-and-forth reads in order even if its marker was rewritten out of sequence; replies sharing a timestamp keep their order. Existing date-only comments still load and display exactly as before.

### Fixed
- The marker hover preview now shows the category's display name (for example "Source needed") instead of its internal id ("source-needed"), matching the side panel.

## [1.8.0] - 2026-06-21

### Added
- "Send comment on Enter" setting (on by default, under Composer). Enter now sends a comment or reply and Shift+Enter starts a new line. Turn it off to send with Cmd/Ctrl+Enter instead, with Enter starting a new line. Applies to both the new-comment composer and the reply box.

## [1.7.2] - 2026-06-21

### Fixed
- Clicking a comment's inline marker icon now opens it in the panel, the same as clicking its underline. Point comments (an icon with no underlined text) were previously unclickable in the editor because the icon is a replaced widget whose clicks were not routed to the editor's click handler; the icon now handles its own click.
- Deleting a comment (and resolve-and-remove) now re-resolves the marker by its id against the current file content before editing. A comment acted on from the side panel could carry a stale cached position if the document had changed since it was indexed, which removed the wrong range and left the marker in the body; matching by id removes the right one.

## [1.7.1] - 2026-06-21

### Fixed
- The settings tab's pre-1.13 fallback no longer relies on suppressing the deprecated-API lint. The imperative re-render now calls a shared renderer instead of the deprecated `display()`, so the build contains no deprecated-API use and no lint suppression. No behavior change on any Obsidian version.

## [1.7.0] - 2026-06-21

### Changed
- New installs now default the composer location to the right side panel instead of the modal dialog, so the document and the passage you are commenting on stay visible while you draft. Existing installs keep their current choice; switch any time under settings.
- Reorganized the settings tab into focused groups so it is clear what each section controls. The previous catch-all "Indicators" group is split into Editor indicators, Resolved comments, Composer, Reading view, and Panel and navigation; "Metadata" is renamed "Authors".

## [1.6.0] - 2026-06-21

### Changed
- Lowered the minimum Obsidian version from 1.13.0 to 1.8.7. The settings tab now supports both the declarative settings API (Obsidian 1.13.0+) and the classic imperative settings tab (older versions), following Obsidian's dual-support migration pattern. Users on Obsidian 1.8.7 through 1.12.x can now install and use the plugin. No change to behavior on 1.13.0+.

## [1.5.1] - 2026-06-21

### Changed
- README updated to document the features added across 1.1.0 to 1.5.0: the AI revision flow (addressed state, lossless originals, accept / revise / reject), the active-comment highlight and stable navigation, the per-reply author picker and per-author colors, and the exported-skill out-of-date indicator. Documentation only; no code changes.

## [1.5.0] - 2026-06-20

### Added
- Exported AI skill staleness detection (F-277). The exported `SKILL.md` now carries a schema version. When the guidance changes in a future update, the "Export AI skill" setting shows an "out of date" indicator and a one-time notice appears on load, so a previously exported skill does not silently teach an assistant the old rules. Re-exporting clears it. The schema version is bumped only when the teaching actually changes, not on every release.

## [1.4.0] - 2026-06-20

### Added
- Per-reply author picker (F-274). The reply composer (both the in-editor popup and the thread panel) now has an author dropdown so distinct collaborators each sign their own reply, instead of every reply using one global tag. Options come from the configured author tag, the collaborators you set up, and anyone already in the thread.
- Per-author styling (F-275). A new "Collaborators and author colors" setting lets you give each author tag a color; that color tints the author's name and replies in the hover popup and the thread panel, so a multi-party conversation is easy to scan.

## [1.3.0] - 2026-06-20

### Added
- Addressed state for the AI revision flow (F-270). A new `[addressed <author> <date>]: <note>` trailing line marks that an edit was applied in response to a comment and is awaiting your accept / revise / reject. It is a highlighted sub-state of open (orange ring on the marker, "addressed" badge in the hover), never hidden from review.
- Lossless originals (F-271). When an assistant replaces the commented passage, the verbatim old text is preserved in an `annoteca-original` fenced block inside the comment, shown as "original (replaced)" in the hover.
- Accept / revise / reject actions in the hover popup. Accept resolves the comment (honoring delete-on-resolve), revise returns it to open for further editing, and reject auto-reverts the prose from the stored original.
- The exported AI skill now teaches the address-by-replace flow with a worked example, and explicitly forbids deleting markers and resolving comments unprompted.

### Changed
- Convert-to-standalone on replace (F-272). An addressed comment whose anchor no longer matches the document is treated as the expected "replaced" state, not flagged as an orphan.

## [1.2.0] - 2026-06-20

### Added
- Direction-agnostic anchor underlines (F-273). The underline over commented text now resolves whether the marker sits before or after the passage, so anchors render on both new and existing comments.

### Changed
- New comments now place their marker at the beginning of the selected text (the prose the comment is about follows the marker). This reads warning-before-text, like `eslint-disable-next-line`. Existing comments whose marker trails the text keep working unchanged: no migration, and end-placement stays valid and supported.

## [1.1.0] - 2026-06-20

### Added
- Active-comment highlight (F-276): the comment whose thread is open in the side panel now gets a soft background over its anchored text and marker in the editor, so you never lose track of which comment you are reading.
- "Center comment when navigating" setting (off by default). When off, jumping to a comment scrolls the editor the minimum needed and does not move at all when the comment is already on screen.

### Changed
- Navigating to a comment no longer force-centers it. Opening the comment panel preserves your reading position: the editor's scroll is captured before the sidebar expands and restored after, so the document stays put.

## [1.0.4] - 2026-06-11

### Changed
- PRIVACY.md now names the vault file enumeration (scopes, diagnostics, bulk convert) and the clipboard write ("Copy ID", write-only) explicitly, per the developer-dashboard preview scan recommendations. No code changes.

## [1.0.3] - 2026-06-11

### Changed
- The worked example in the README and the exported AI skill now uses a business document (a forecast sentence) instead of fiction prose. The example still round-trips through the real parser in tests.

## [1.0.2] - 2026-06-11

### Added
- Settings tab footer with the plugin version, GitHub link, and Report Issues link, matching the convention used by the maintainer's other plugins.

### Changed
- Removed the version/repo footer from the exported AI skill file (added in 1.0.1); the settings footer is the right home for that information.

## [1.0.1] - 2026-06-11

### Fixed
- Marker clicks and hub-opening actions now actually open the right sidebar when it is collapsed. The hub leaf is pre-created at startup, and the old activation path only set it active, which does not expand a collapsed sidebar; the panel appeared to never open unless it had been opened manually. Activation now goes through `workspace.revealLeaf`, awaited, which also resolves the deferred view before comment-selection events are emitted at it.

### Changed
- The exported AI skill file now ends with a footer naming the generating plugin version and linking the repository, with a reminder to re-export after category changes or upgrades.

## [1.0.0] - 2026-06-11

First stable release, prepared for Obsidian community plugin submission. No code changes since 0.9.0.

### Changed
- README rewritten to document the full feature set: categories and presets, anchored underlines, threaded conversations, the comment hub, reading-view indicators, resolve workflows, imports, and the AI skill export. Minimum-Obsidian badge corrected to 1.13.0.
- PRIVACY.md data-flow section filled in (it previously carried a template placeholder).

## [0.9.0] - 2026-06-11

### Added
- "Resolve and remove" action: resolves a comment by deleting its marker from the file instead of keeping a [resolved ...] line. Available everywhere Resolve appears: Thread tab card, hover popup, editor right-click menu, and a new "Resolve and remove comment here" command. Always asks for confirmation (same modal as delete, with resolve wording).
- "Delete on resolve" setting (off by default). When enabled, plain Resolve removes the marker without asking; the toggle is the opt-in. Keep-in-place history remains the default behavior.

## [0.8.0] - 2026-06-11

### Added
- Reading-view comment indicator. Markers are HTML comments, which the reading-view renderer drops, so until now comments were completely invisible in reading view. A new "Reading view indicator" setting shows a note-level banner with the file's open/resolved totals (default), a badge on each section that contains comments, both, or nothing. Counts are threads; replies are not counted. Clicking an indicator opens the comment panel on that comment.

## [0.7.0] - 2026-06-11

### Added
- "Export AI skill" command and settings button. Writes a SKILL.md into the vault that teaches an AI assistant the marker grammar, the reply/resolve conventions, and this vault's configured categories. A new "Skill export destination" setting picks the folder: `.claude/skills/annoteca/` (Claude Code, the default), `.agent/skills/annoteca/` (other assistants), or both. The shipped example marker is covered by a test that parses it with the real parser, so the taught grammar cannot drift from the implementation.

## [0.6.0] - 2026-06-10

### Changed
- Internal restructuring, no behavior change:
  - The five vault-scanning diagnostics commands moved from the plugin class into a new `diagnostics-service.ts`; the three marker scans (conflicts, orphans, validation) now share one parameterized scan loop instead of three copies. `main.ts` drops from 1,044 to 943 lines.
  - The four sidebar views share an `AnnotecaBaseView` base class for plugin injection and close-time cleanup instead of copy-pasted constructors.
  - The two comment converters in `imports.ts` share one replacement engine.

### Fixed
- Long-running commands (diagnostics, drift check, bulk convert, settings backup/restore) now surface failures as a notice instead of dying silently into the developer console mid-scan.
- Settings restore logs the underlying parse error to the console alongside the "not valid JSON" notice, so a malformed backup can actually be debugged.
- The icon picker no longer leaves its deferred focus timer running when the modal is closed before the timer fires.

## [0.5.1] - 2026-06-10

### Changed
- tsconfig `lib` extended to ES2017/ES2018 to match the code and the esbuild target. Type-check-only; no runtime change in the built plugin.

## [0.5.0] - 2026-06-05

### Changed
- Author identifier is far less restrictive. Tags like `Charles`, `J.Doe`, or `AI-Bot` are stored and written into comment metadata as typed, instead of being forced to lowercase letters/digits/dashes. The only characters not allowed are the ones that would break the storage format: spaces (the field delimiter in reply and resolved lines), `]`, `<`, and `>`. The parser accepts these authors in `[author=...]`, `[reply ...]`, and `[resolved ...]` lines; existing tags are unaffected. The settings field placeholder is now a generic `reviewer`.

## [0.4.0] - 2026-06-05

### Changed
- Requires Obsidian 1.13.0 or later. Obsidian keeps serving 0.3.1 to vaults on older versions, so nothing breaks for them.
- Settings migrated to Obsidian's declarative settings API. The Indicators, Metadata, and Diagnostics options are now indexed in Obsidian's global settings search and grouped into labeled sections, and the author identifier and debug log destination rows now show or hide live as you toggle their parent option. The preset browser, category accordion, and add-category form keep their full-width custom controls. No setting changed its stored value or behavior.
- Replaced the deprecated `setWarning()` calls on the delete confirmation buttons with `setDestructive()` for the Obsidian 1.13.0 API.

## [0.3.1] - 2026-05-26

### Fixed
- **Hover popup closed the moment the mouse moved when hovering an anchor underline.** The anchor-underline hover predicate (added in 0.3.0) set the tooltip's source range to the marker icon's range even when the user was hovering the anchor underline. CodeMirror's keepalive then dismissed the tooltip on any mouse movement because the cursor was already "outside" the declared source range. Fix: the tooltip now reports whichever range the mouse is actually over (marker or anchor underline).
- **Resolve / reopen / delete / append-reply could be silently clobbered by the editor's autosave when the file was open.** `vault.modify` was racing the editor's in-memory document; if the editor had any state to flush, it would overwrite the new content and "restore" the marker the user had just acted on. Lifecycle writes now go through `editor.replaceRange` when the file is open in any markdown leaf (keeping the CodeMirror EditorState authoritative) and fall back to `vault.modify` only when the file is not open. This matches the pattern the edit composer was already using.

### Added
- **Confirmation prompt before single-comment delete.** Every entry point (Thread tab "Delete" button, editor right-click menu, command palette "Delete comment here") now shows a small modal with the comment's category badge and body excerpt before removing the marker. The bulk "Delete all resolved comments in this file" command has its own confirmation and is unchanged.

### Changed (internal — no behavior difference)
- `AnnotecaPanelView` extracted into a ~100-line dispatcher plus three focused renderer modules: `hub-thread-tab.ts`, `hub-outline-tab.ts`, `hub-starred-tab.ts`. The Thread tab's per-session state (collapse paths, active comment) lives with the Thread renderer rather than on the parent view.
- Long render methods inside the Thread renderer split into focused helpers: `buildScopedGroups`, `selectActiveComment`, `applyAutoCollapsePolicy`, `renderFileGroup`, `renderCompactRow`, `renderExpandedSection`.
- Comment lifecycle verbs (`resolveComment`, `reopenComment`, `deleteComment`, `appendReply`, `replaceMarker`, `listResolvedInFile`, `deleteAllResolvedInFile`, `resolvedAuthor`) moved into a new `CommentService` module. `AnnotecaPlugin` keeps thin pass-through methods so external callers do not change.

## [0.3.0] - 2026-05-26

This release bundles several distinct feature themes that landed on `main` before a release boundary was cut. Going forward, plugin releases will partition per feature theme; see the workspace `CLAUDE.md` "Release cadence" note.

### Added

#### Hub panel overhaul
- Replaced the three earlier sidebar views with a single right-sidebar hub (`Annoteca` view) containing Thread / Outline / Starred internal tabs.
- **Scope selector** on the Thread tab: This file, This folder (with and without subfolders), Vault, Property `key = value` (frontmatter-driven), Tag. Property and Tag option lists populate from the active file. Scope state persists across restarts; auto-collapses to "this file" when the active file moves outside the current scope and scope is unpinned.
- **Pin button** on the scope toolbar to lock scope to a specific path; pinned scope ignores file changes.
- **Multi-file scope rendering**: comments group by file with per-file header + count badge. Single-file scope renders without the per-file header since the panel header already implies the file.
- **Starred (bookmarked) comments** persisted in settings. Star toggle in three places: hover popup header, Thread tab card header, Starred tab card. Comments without an ID cannot be starred. Starred tab lists most-recently-starred first.
- **Reply drafts**: in-progress reply text persists to vault-local storage (not `data.json`, so it does not propagate via Obsidian Sync). Debounced on input, restored on composer open, cleared on send. Composer outside-click no longer dismisses a non-empty composer.
- **Outline tab interactions**: open/resolved count badges per heading are clickable — click navigates to the first matching comment in that section. Row containing the cursor is highlighted.
- Internal tab selection persists across restarts (`settings.lastHubTab`); marker clicks force the Thread tab.
- Next/previous comment commands respect scope and walk across files within scope.
- **Delete all resolved comments in this file** command (confirmation modal sized to count, single write, rebuild index).

#### Settings UX
- **Accordion category rows**: only the active category expands; others collapse to a single-line summary.
- **Leaner icon and color pickers**: the icon picker is now a stacked search-and-grid, the color picker shows theme-adaptive swatches with a custom-color chip beneath.
- **Browse presets**: cherry-pick categories from `general`, `scholarly`, `fiction`, `code-review`, and `project-planning` presets into the working list (additive, not destructive). User-saved presets persist in `settings.customPresets`.
- Removed the `enableScholarlyPreset` boolean toggle; its categories now live inside the `scholarly` preset.
- Long-form settings rows (textareas, multi-control rows) now use a stacked layout (label/description above, control below) rather than fighting Obsidian's narrow right-rail `Setting` widget.

#### Color picker (custom chip seeding)
- Native `<input type="color">` chip is silently seeded from the currently active theme swatch (resolved to hex via `getComputedStyle`), so opening the OS picker opens it on the theme color, ready to nudge into a variation.

#### Anchor underlines for commented text
- New marker syntax tail line `[anchor=<commented text>]` captures the text the comment was attached to at creation.
- Renders a category-tinted underline over the anchor range in the editor; clicking or hovering the underline triggers the same comment popup as the inline marker.
- Configurable indicator style includes a new `"underline"` option (in addition to `"icon"`, `"gutter"`, `"both"`, `"none"`).

#### Resolved-state polish
- Resolved comments always show an icon (no longer category-toggled).
- Resolved comments in scope lists render with strikethrough.
- New brightness toggle controls dimming of resolved entries.

### Fixed
- **Hide-all-comments was global with confused bookkeeping**: a per-view `__annotecaHidden` field was being written but never read; the decoration compute only consulted a module-level singleton. A toggle in pane B would silently affect pane A. Per-view writes have been removed; the toggle is now unambiguously global (one switch, all editors).
- **`rgbStringToHex` no longer silently returns `#000000` on malformed input**. Returns `undefined` instead, so callers can skip the assignment rather than seeding black on a `transparent` or `display:none` swatch.

### Changed
- Removed the `AnnotecaEvents` class wrapper around Obsidian's `Events`. Call sites now use `events.trigger(...)` directly.
- Type augmentations for the Obsidian API moved from `types.d.ts` (which was being shadowed by the runtime `types.ts`) to `globals.d.ts`. Added a proper `Editor.cm` augmentation that removes four `as unknown as` double-casts from `main.ts` and one from `decorations.ts`.
- `tsconfig.json` `include` now lists `**/*.d.ts` explicitly so ambient declaration files compile (TypeScript's `**/*.ts` glob does not match `.d.ts`).
- Pure helpers extracted for unit-testability:
  - `scope.ts` — scope-shape dispatch (`computeScopeFileSet`).
  - `view-utils.ts` — `extractIndexTerm`, `bucketCommentsByHeading`.
  - `rgbStringToHex` exported from `ui-helpers.ts`.
- New test suite `__tests__/helpers.test.ts` covers all four (30 new tests).

## [0.2.0] - 2026-05-26

First public release. Bundles the V1 foundation and the full V2 feature set.

### Added
- V2 features:
  - Threaded replies UI in the reviewer pane (F-021, F-066): reply input persists into the parent comment as a chronological `[reply ...]` line.
  - Outline density view (F-048) listing the active file's headings with open and resolved comment counts per heading.
  - Author tag toggle (F-075) wiring the optional `[author=...]` field into the modal and the resolution / reply paths.
  - Per-category icon customization (F-204) rendered in the sidebar group headers and reviewer pane category badge.
  - Per-category modal templates (F-212) for `verse-needed`, `source-needed`, and `index-entry`, composing structured field values into the comment body.
  - Import commands (F-221, F-222, F-230) for converting native `%%comments%%` and generic HTML comments to the canonical format, gated by a backup-confirmation modal.
  - Position drift detection (F-234) that snapshots surrounding-text signatures and reports drift on subsequent runs.
  - Settings backup and restore (F-236) writing to a JSON file in the vault.
  - Self-diagnostic command (F-237) writing a status summary to an in-vault note.
  - Scripture reference auto-formatting (F-251) command rewriting `john 3:16 esv` to `John 3:16 (ESV)` for the known 66-book canon and a list of common translations.
  - Index-entry category preset (F-260) plus a Pandoc Lua filter (`docs/pandoc-annoteca.lua`) that maps `index-entry` comments to LaTeX `\index{}` at export time.
- UX improvements after first live-test feedback:
  - The reviewer pane now lists every comment in the active file as collapsible cards; the active comment is expanded for reply and lifecycle actions, others are previews that promote on click.
  - Adding a new comment auto-opens the reviewer pane with that comment selected.
  - Optional "right side panel" composer location as an alternative to the modal dialog.
  - Ribbon icon for opening the reviewer pane, and an idempotent first-load placement of the pane in the right sidebar so its tab icon appears next to the native sidebar tabs.

### Fixed
- Marker text no longer leaks through in Live Preview. The decoration now replaces the raw `<!-- annoteca/...-->` with a small category-tinted glyph when the cursor is outside the marker; the raw text is restored when the cursor enters the marker so direct editing still works.
- Switched the file-navigation path off the deprecated `getLeaf(false)` API onto `getMostRecentLeaf()` with a tab-fallback, clearing the CI deprecated-API gate.

## [0.1.0] - 2026-05-25

### Added
- V1 plugin implementation:
  - Pure parser and serializer for the Annoteca marker format (`<!-- annoteca/<category>: <body> -->`), with metadata, threaded replies, and resolution lines round-tripping cleanly through `parse(serialize(c))`.
  - In-memory per-file comment index with vault-wide queries by file, category, and resolved state.
  - Default category set (tone, clarify, cut, expand, tighten, source-needed, uncategorized) and an optional scholarly preset (verse-needed, meditation).
  - Settings tab covering categories, indicator style, default visibility, resolved-comment display, author tag, and debug mode.
  - Add-comment modal with category dropdown, body input, and a scratchpad toggle.
  - CodeMirror 6 extension that decorates markers with category-tinted underlines, hover preview tooltips, and click-to-open-reviewer interactions.
  - Per-file sidebar grouped by category, a vault-wide unresolved comments view with path/category/resolved filters, and a reviewer pane with reply input and lifecycle actions (resolve, reopen, edit, delete, copy ID, navigate).
  - Comment lifecycle commands: add, edit, delete, resolve, reopen, reply, scratchpad capture.
  - Navigation commands: next, previous, next-unresolved, previous-unresolved, plus hide-all-comments and cycle-indicator-style.
  - Diagnostics commands: marker conflict detector, orphan comment detector, format validation.
  - Editor right-click menu integration mirroring the comment lifecycle actions.
- Initial release.
