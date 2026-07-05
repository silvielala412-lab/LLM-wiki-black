import { t as create } from "./react-yWv6PLLo.js";
//#region src/lib/review-utils.ts
/**
* Shared helpers for reasoning about review items.
* Kept dependency-free so both the Zustand store and sweep logic can import
* it without creating cycles or pulling heavy LLM modules into the store.
*/
var REVIEW_TITLE_PREFIX_RE = /^(missing[\s-]?page[:：]\s*|duplicate[\s-]?page[:：]\s*|possible[\s-]?duplicate[:：]\s*|缺失页面[:：]\s*|缺少页面[:：]\s*|重复页面[:：]\s*|疑似重复[:：]\s*)/i;
/**
* Normalize a review title for equality comparison:
*   - strip leading "Missing page:" / "缺失页面:" / etc.
*   - collapse whitespace
*   - lowercase
*
* Two review items with the same (type, normalized title) are considered
* the same concept and should be merged rather than duplicated.
*/
function normalizeReviewTitle(title) {
	return title.replace(REVIEW_TITLE_PREFIX_RE, "").replace(/\s+/g, " ").trim().toLowerCase();
}
//#endregion
//#region src/stores/review-store.ts
var counter = 0;
var useReviewStore = create((set) => ({
	items: [],
	addItem: (item) => set((state) => ({ items: [...state.items, {
		...item,
		id: `review-${++counter}`,
		resolved: false,
		createdAt: Date.now()
	}] })),
	addItems: (items) => set((state) => {
		const result = [...state.items];
		const keyFor = (t, title) => `${t}::${normalizeReviewTitle(title)}`;
		const pendingIndex = /* @__PURE__ */ new Map();
		result.forEach((it, idx) => {
			if (!it.resolved) pendingIndex.set(keyFor(it.type, it.title), idx);
		});
		for (const incoming of items) {
			const k = keyFor(incoming.type, incoming.title);
			const existingIdx = pendingIndex.get(k);
			if (existingIdx !== void 0) {
				const old = result[existingIdx];
				const mergedPages = Array.from(new Set([...old.affectedPages ?? [], ...incoming.affectedPages ?? []]));
				const mergedQueries = Array.from(new Set([...old.searchQueries ?? [], ...incoming.searchQueries ?? []]));
				result[existingIdx] = {
					...old,
					description: incoming.description || old.description,
					sourcePath: incoming.sourcePath ?? old.sourcePath,
					affectedPages: mergedPages.length > 0 ? mergedPages : void 0,
					searchQueries: mergedQueries.length > 0 ? mergedQueries : void 0,
					conflict: incoming.conflict ?? old.conflict
				};
			} else {
				const newItem = {
					...incoming,
					id: `review-${++counter}`,
					resolved: false,
					createdAt: Date.now()
				};
				result.push(newItem);
				pendingIndex.set(k, result.length - 1);
			}
		}
		return { items: result };
	}),
	setItems: (items) => set({ items }),
	resolveItem: (id, action) => set((state) => ({ items: state.items.map((item) => item.id === id ? {
		...item,
		resolved: true,
		resolvedAction: action
	} : item) })),
	dismissItem: (id) => set((state) => ({ items: state.items.filter((item) => item.id !== id) })),
	clearResolved: () => set((state) => ({ items: state.items.filter((item) => !item.resolved) }))
}));
//#endregion
export { normalizeReviewTitle as n, useReviewStore as t };
