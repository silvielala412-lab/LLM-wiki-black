/**
 * auth-store.ts — Client-side auth state
 * Persists user info to sessionStorage so a page refresh doesn't flash the login page
 */
import { create } from "zustand"

interface AuthUser {
  id: string
  username: string
}

interface AuthState {
  user: AuthUser | null
  isLoading: boolean
  // Actions
  checkSession: () => Promise<void>
  login: (username: string, password: string) => Promise<void>
  register: (username: string, password: string, confirmPassword: string) => Promise<void>
  logout: () => Promise<void>
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  isLoading: true,

  checkSession: async () => {
    set({ isLoading: true })
    try {
      const res = await fetch("/api/auth/me", { credentials: "include" })
      if (res.ok) {
        const user = await res.json()
        set({ user, isLoading: false })
      } else {
        set({ user: null, isLoading: false })
      }
    } catch {
      set({ user: null, isLoading: false })
    }
  },

  login: async (username, password) => {
    const res = await fetch("/api/auth/login", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    })
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      throw new Error(data.error ?? "Login failed")
    }
    const user = await res.json()
    set({ user })
  },

  register: async (username, password, confirmPassword) => {
    const res = await fetch("/api/auth/register", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password, confirm_password: confirmPassword }),
    })
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      throw new Error(data.error ?? "Registration failed")
    }
    const user = await res.json()
    set({ user })
  },

  logout: async () => {
    await fetch("/api/auth/logout", { method: "POST", credentials: "include" })
    set({ user: null })
  },
}))
