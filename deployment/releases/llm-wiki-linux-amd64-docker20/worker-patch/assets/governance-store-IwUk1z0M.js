import { t as create } from "./react-yWv6PLLo.js";
import { a as resolveReviewItem, i as loadReviewQueue, n as dismissReviewItem, r as filterPendingItems, t as appendReviewItem } from "./knowledge-governance-DMRKOqLG.js";
//#region src/stores/governance-store.ts
/**
* governance-store.ts
*
* UI state for the knowledge governance Review Queue.
* Backed by review-queue.json on disk via knowledge-governance/index.ts.
*/
var useGovernanceStore = create((set, get) => ({
	items: [],
	isLoading: false,
	pendingCount: 0,
	loadQueue: async (projectPath) => {
		set({ isLoading: true });
		try {
			const items = await loadReviewQueue(projectPath);
			set({
				items,
				pendingCount: filterPendingItems(items).length,
				isLoading: false
			});
		} catch {
			set({ isLoading: false });
		}
	},
	addItem: async (projectPath, item) => {
		await appendReviewItem(projectPath, item);
		const items = await loadReviewQueue(projectPath);
		set({
			items,
			pendingCount: filterPendingItems(items).length
		});
	},
	resolve: async (projectPath, id, resolution) => {
		await resolveReviewItem(projectPath, id, resolution, "user");
		const items = get().items.map((i) => i.id === id ? {
			...i,
			status: "resolved",
			resolution,
			resolvedBy: "user",
			resolvedAt: (/* @__PURE__ */ new Date()).toISOString()
		} : i);
		set({
			items,
			pendingCount: filterPendingItems(items).length
		});
	},
	dismiss: async (projectPath, id) => {
		await dismissReviewItem(projectPath, id);
		const items = get().items.map((i) => i.id === id ? {
			...i,
			status: "dismissed"
		} : i);
		set({
			items,
			pendingCount: filterPendingItems(items).length
		});
	}
}));
//#endregion
export { useGovernanceStore };
