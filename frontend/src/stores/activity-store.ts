import { create } from "zustand"

export interface ActivityItem {
  id: string
  type: "ingest" | "lint" | "query"
  title: string
  status: "running" | "done" | "error"
  detail: string
  filesWritten: string[]
  createdAt: number
  // P3: granular progress fields
  /** Current pipeline step label, e.g. "OCR page 3/12" or "Writing entities" */
  step?: string
  /** Number of wiki files written so far during this task (for progress bar) */
  doneFiles?: number
  /** Total expected wiki files for this task (estimated) */
  totalFiles?: number
  /** Count of entity pages merged/deduped by P2 entity normalizer */
  mergedEntities?: number
  /** Count of entity pages newly created */
  newEntities?: number
}

interface ActivityState {
  items: ActivityItem[]
  addItem: (item: Omit<ActivityItem, "id" | "createdAt">) => string
  updateItem: (id: string, updates: Partial<Pick<ActivityItem,
    "status" | "detail" | "filesWritten" | "step" | "doneFiles" | "totalFiles" | "mergedEntities" | "newEntities"
  >>) => void
  appendDetail: (id: string, text: string) => void
  /** Set the current step label shown below the title */
  setStep: (id: string, step: string) => void
  /** Increment doneFiles counter by 1 */
  incrementDone: (id: string) => void
  /** Record an entity merge event (P2 dedup) */
  addMergedEntity: (id: string) => void
  /** Record a newly created entity */
  addNewEntity: (id: string) => void
  clearDone: () => void
}

let counter = 0

export const useActivityStore = create<ActivityState>((set) => ({
  items: [],

  addItem: (item) => {
    const id = `activity-${++counter}`
    set((state) => ({
      items: [
        { ...item, id, createdAt: Date.now(), doneFiles: 0, mergedEntities: 0, newEntities: 0 },
        ...state.items,
      ],
    }))
    return id
  },

  updateItem: (id, updates) =>
    set((state) => ({
      items: state.items.map((item) =>
        item.id === id ? { ...item, ...updates } : item
      ),
    })),

  appendDetail: (id, text) =>
    set((state) => ({
      items: state.items.map((item) =>
        item.id === id ? { ...item, detail: item.detail + text } : item
      ),
    })),

  setStep: (id, step) =>
    set((state) => ({
      items: state.items.map((item) =>
        item.id === id ? { ...item, step } : item
      ),
    })),

  incrementDone: (id) =>
    set((state) => ({
      items: state.items.map((item) =>
        item.id === id ? { ...item, doneFiles: (item.doneFiles ?? 0) + 1 } : item
      ),
    })),

  addMergedEntity: (id) =>
    set((state) => ({
      items: state.items.map((item) =>
        item.id === id ? { ...item, mergedEntities: (item.mergedEntities ?? 0) + 1 } : item
      ),
    })),

  addNewEntity: (id) =>
    set((state) => ({
      items: state.items.map((item) =>
        item.id === id ? { ...item, newEntities: (item.newEntities ?? 0) + 1 } : item
      ),
    })),

  clearDone: () =>
    set((state) => ({
      items: state.items.filter((i) => i.status === "running"),
    })),
}))
