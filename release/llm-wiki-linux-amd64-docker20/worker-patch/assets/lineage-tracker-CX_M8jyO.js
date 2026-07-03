import { n as __exportAll } from "./react-yWv6PLLo.js";
import { o as readFile, u as writeFile } from "./fs-WYeR_9ZT.js";
//#region src/lib/knowledge-governance/lineage-tracker.ts
/**
* knowledge-governance/lineage-tracker.ts
*
* Tracks knowledge transition records — when a new page supersedes an
* old one, this module records the event with semantic diff points
* extracted by the LLM.
*
* Storage: {projectPath}/knowledge-lineage.json
*
* Pure FS — no UI. Called by the Review Panel when the user confirms
* a "superseded" or "merged" resolution.
*/
var lineage_tracker_exports = /* @__PURE__ */ __exportAll({
	appendTransition: () => appendTransition,
	loadLineage: () => loadLineage,
	recordTransition: () => recordTransition
});
var LINEAGE_FILE = "knowledge-lineage.json";
function lineagePath(projectPath) {
	return `${projectPath}/${LINEAGE_FILE}`;
}
async function loadLineage(projectPath) {
	try {
		const raw = await readFile(lineagePath(projectPath));
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}
async function appendTransition(projectPath, transition) {
	const records = await loadLineage(projectPath);
	if (!records.some((r) => r.fromPagePath === transition.fromPagePath && r.toPagePath === transition.toPagePath)) {
		records.push(transition);
		await writeFile(lineagePath(projectPath), JSON.stringify(records, null, 2));
	}
}
/**
* Inject lineage pointers into page frontmatter:
*   Old page: superseded_by: "path/to/new"
*   New page: supersedes: "path/to/old"
*/
async function injectLineageFrontmatter(pagePath, field, value) {
	try {
		const content = await readFile(pagePath);
		if (content.includes(`${field}:`)) return;
		await writeFile(pagePath, content.match(/^---\r?\n/) ? content.replace(/^(---\r?\n)/, `$1${field}: "${value.replace(/"/g, "\\\"")}"\n`) : `---\n${field}: "${value}"\n---\n\n${content}`);
	} catch (err) {
		console.warn(`[lineage-tracker] Failed to inject ${field} into ${pagePath}:`, err);
	}
}
/**
* Record a knowledge supersession event.
* Call this AFTER the user confirms "替代旧版本" in the Review Panel.
*
* @param projectPath  Absolute project root
* @param fromPagePath Absolute path to the OLD page
* @param fromPageTitle Title of the old page
* @param toPagePath   Absolute path to the NEW page
* @param toPageTitle  Title of the new page
* @param diffResult   Semantic diff from the diff engine (may be null if LLM failed)
* @param relation     Type of transition
*/
async function recordTransition(projectPath, fromPagePath, fromPageTitle, toPagePath, toPageTitle, diffResult, relation = "supersedes", resolvedBy = "user", reviewedBy) {
	const transition = {
		id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
		relation,
		fromPagePath,
		fromPageTitle,
		toPagePath,
		toPageTitle,
		effectiveDate: (/* @__PURE__ */ new Date()).toISOString(),
		addedPoints: diffResult?.addedPoints ?? [],
		removedPoints: diffResult?.removedPoints ?? [],
		changedPoints: diffResult?.changedPoints ?? [],
		summary: diffResult?.summary ?? `「${toPageTitle}」替代了「${fromPageTitle}」`,
		resolvedBy,
		reviewedBy
	};
	await appendTransition(projectPath, transition);
	if (resolvedBy === "user") {
		await injectLineageFrontmatter(fromPagePath, "superseded_by", toPagePath);
		await injectLineageFrontmatter(toPagePath, "supersedes", fromPagePath);
	}
	return transition;
}
//#endregion
export { recordTransition as i, lineage_tracker_exports as n, loadLineage as r, appendTransition as t };
