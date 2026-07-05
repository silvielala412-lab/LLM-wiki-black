/**
 * governance-store.ts
 *
 * UI state for the knowledge governance Review Queue.
 * Backed by review-queue.json on disk via knowledge-governance/index.ts.
 */

import { create } from "zustand"
import type { ReviewItem, ReviewResolution } from "@/lib/knowledge-governance"
import {
  loadReviewQueue,
  resolveReviewItem,
  dismissReviewItem,
  filterPendingItems,
  appendReviewItem,
} from "@/lib/knowledge-governance"

interface GovernanceState {
  items: ReviewItem[]
  isLoading: boolean
  /** Number of pending items for the sidebar badge */
  pendingCount: number

  // Actions
  loadQueue: (projectPath: string) => Promise<void>
  addItem: (projectPath: string, item: ReviewItem) => Promise<void>
  resolve: (projectPath: string, id: string, resolution: ReviewResolution) => Promise<void>
  dismiss: (projectPath: string, id: string) => Promise<void>
}

export const useGovernanceStore = create<GovernanceState>((set, get) => ({
  items: [],
  isLoading: false,
  pendingCount: 0,

  loadQueue: async (projectPath) => {
    set({ isLoading: true })
    try {
      const items = await loadReviewQueue(projectPath)
      set({ items, pendingCount: filterPendingItems(items).length, isLoading: false })
    } catch {
      set({ isLoading: false })
    }
  },

  addItem: async (projectPath, item) => {
    await appendReviewItem(projectPath, item)
    const items = await loadReviewQueue(projectPath)
    set({ items, pendingCount: filterPendingItems(items).length })
  },

  resolve: async (projectPath, id, resolution) => {
    await resolveReviewItem(projectPath, id, resolution, "user")
    const items = get().items.map((i) =>
      i.id === id
        ? { ...i, status: "resolved" as const, resolution, resolvedBy: "user" as const, resolvedAt: new Date().toISOString() }
        : i,
    )
    set({ items, pendingCount: filterPendingItems(items).length })
  },

  dismiss: async (projectPath, id) => {
    await dismissReviewItem(projectPath, id)
    const items = get().items.map((i) =>
      i.id === id ? { ...i, status: "dismissed" as const } : i,
    )
    set({ items, pendingCount: filterPendingItems(items).length })
  },
}))
