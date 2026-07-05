import { n as __exportAll } from "./react-yWv6PLLo.js";
//#region src/lib/sources-merge.ts
var sources_merge_exports = /* @__PURE__ */ __exportAll({
	mergeSourcesIntoContent: () => mergeSourcesIntoContent,
	mergeSourcesLists: () => mergeSourcesLists,
	parseSources: () => parseSources,
	writeSources: () => writeSources
});
/**
* Merge a page's YAML frontmatter `sources:` array with what the LLM
* just emitted, so re-ingesting a page that already has a history from
* another source doesn't silently clobber that history.
*
* Why this exists: the stage-2 prompt instructs the LLM to emit
* `sources: ["${sourceFileName}"]` — with JUST the current source — on
* every FILE block. The stage-2 prompt also doesn't feed existing page
* bodies into the context, so the LLM can't see the old sources. If
* the ingest write were naive, each re-ingest would overwrite the
* sources array with a single-element list, and the downstream
* source-delete logic would later treat the page as single-sourced and
* delete it — losing content contributed by the earlier source.
*
* The fix: before writing, read the existing file (if any), parse its
* sources, union with the freshly emitted sources, rewrite the frontmatter.
*/
/**
* Extract `sources: [...]` from the YAML frontmatter of a wiki page.
* Returns `[]` when no sources line is found or parsing fails.
*
* Handles both single-line form (`sources: ["a.md", "b.md"]`) and the
* multi-line YAML list form (`sources:\n  - a.md\n  - b.md`). Single
* and double quotes on items are stripped; bare items are accepted.
*/
function parseSources(content) {
	const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
	const fm = fmMatch ? fmMatch[1] : content;
	const multi = fm.match(/^sources:\s*\n((?:[ \t]+-\s+.+\n?)+)/m);
	if (multi) {
		const out = [];
		for (const line of multi[1].split("\n")) {
			const m = line.match(/^\s+-\s+["']?(.+?)["']?\s*$/);
			if (m && m[1]) out.push(m[1].trim());
		}
		return out;
	}
	const inline = fm.match(/^sources:\s*\[([^\]]*)\]/m);
	if (!inline) return [];
	const body = inline[1].trim();
	if (body === "") return [];
	return body.split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter((s) => s.length > 0);
}
/**
* Rewrite the `sources:` field of a markdown page's frontmatter to the
* provided array. Preserves every other frontmatter line. If no
* `sources:` line exists (LLM forgot it), one is inserted just before
* the closing `---`. If no frontmatter exists at all, returns the
* content unchanged — we don't manufacture frontmatter for pages the
* LLM didn't frontmatter-prefix, since that almost certainly means
* the emission was already malformed and the caller should surface it.
*/
function writeSources(content, sources) {
	const fmMatch = content.match(/^(---\n)([\s\S]*?)(\n---)/);
	if (!fmMatch) return content;
	const [, openDelim, fmBody, closeDelim] = fmMatch;
	const newLine = `sources: [${sources.map((s) => `"${s}"`).join(", ")}]`;
	if (/^sources:\s*\[[^\]]*\]/m.test(fmBody)) return `${openDelim}${fmBody.replace(/^sources:\s*\[[^\]]*\]/m, newLine)}${closeDelim}${content.slice(fmMatch[0].length)}`;
	if (/^sources:\s*\n((?:[ \t]+-\s+.+\n?)+)/m.test(fmBody)) return `${openDelim}${fmBody.replace(/^sources:\s*\n((?:[ \t]+-\s+.+\n?)+)/m, newLine)}${closeDelim}${content.slice(fmMatch[0].length)}`;
	return `${openDelim}${`${fmBody}\n${newLine}`}${closeDelim}${content.slice(fmMatch[0].length)}`;
}
/**
* Merge two source lists, case-insensitively deduped. Order of existing
* entries is preserved; new entries not already present are appended
* in the order they appear in `incoming`.
*
* Case handling: if both lists contain the same name but with different
* casing (e.g. "Test.md" and "test.md"), the first-seen form wins.
* This keeps the user's original filename casing stable on disk.
*/
function mergeSourcesLists(existing, incoming) {
	const seen = /* @__PURE__ */ new Set();
	const out = [];
	for (const s of [...existing, ...incoming]) {
		const key = s.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(s);
	}
	return out;
}
/**
* The main entry point used from ingest: given the content the LLM
* just emitted for a page (`newContent`), and whatever is currently on
* disk at that path (`existingContent`, or null if the page is new),
* return content whose `sources:` field is the union of both.
*
* For new pages: returns newContent unchanged.
* For existing pages with no frontmatter: returns newContent unchanged
*   (don't corrupt unconventional files).
* For existing pages with frontmatter: merges sources, rewrites.
*/
function mergeSourcesIntoContent(newContent, existingContent) {
	if (!existingContent) return newContent;
	const oldSources = parseSources(existingContent);
	if (oldSources.length === 0) return newContent;
	const newSources = parseSources(newContent);
	const merged = mergeSourcesLists(oldSources, newSources);
	if (merged.length === newSources.length && merged.every((s, i) => s === newSources[i])) return newContent;
	return writeSources(newContent, merged);
}
//#endregion
export { writeSources as i, parseSources as n, sources_merge_exports as r, mergeSourcesLists as t };
