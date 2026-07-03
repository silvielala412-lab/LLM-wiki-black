import { t as create } from "./react-yWv6PLLo.js";
//#region src/stores/activity-store.ts
var counter = 0;
var useActivityStore = create((set) => ({
	items: [],
	addItem: (item) => {
		const id = `activity-${++counter}`;
		set((state) => ({ items: [{
			...item,
			id,
			createdAt: Date.now(),
			doneFiles: 0,
			mergedEntities: 0,
			newEntities: 0
		}, ...state.items] }));
		return id;
	},
	updateItem: (id, updates) => set((state) => ({ items: state.items.map((item) => item.id === id ? {
		...item,
		...updates
	} : item) })),
	appendDetail: (id, text) => set((state) => ({ items: state.items.map((item) => item.id === id ? {
		...item,
		detail: item.detail + text
	} : item) })),
	setStep: (id, step) => set((state) => ({ items: state.items.map((item) => item.id === id ? {
		...item,
		step
	} : item) })),
	incrementDone: (id) => set((state) => ({ items: state.items.map((item) => item.id === id ? {
		...item,
		doneFiles: (item.doneFiles ?? 0) + 1
	} : item) })),
	addMergedEntity: (id) => set((state) => ({ items: state.items.map((item) => item.id === id ? {
		...item,
		mergedEntities: (item.mergedEntities ?? 0) + 1
	} : item) })),
	addNewEntity: (id) => set((state) => ({ items: state.items.map((item) => item.id === id ? {
		...item,
		newEntities: (item.newEntities ?? 0) + 1
	} : item) })),
	clearDone: () => set((state) => ({ items: state.items.filter((i) => i.status === "running") }))
}));
//#endregion
export { useActivityStore };
