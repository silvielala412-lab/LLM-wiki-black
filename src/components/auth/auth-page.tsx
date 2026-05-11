import { useState } from "react"
import { useAuthStore } from "@/stores/auth-store"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { BookOpen, Loader2, User, Lock, Eye, EyeOff, UserPlus, LogIn } from "lucide-react"

type Tab = "login" | "register"

export function AuthPage() {
  const [tab, setTab] = useState<Tab>("login")
  const [username, setUsername] = useState("")
  const [password, setPassword] = useState("")
  const [confirmPassword, setConfirmPassword] = useState("")
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)

  const { login, register } = useAuthStore()

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setIsSubmitting(true)
    try {
      if (tab === "login") {
        await login(username, password)
      } else {
        await register(username, password, confirmPassword)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error")
    } finally {
      setIsSubmitting(false)
    }
  }

  function switchTab(t: Tab) {
    setTab(t)
    setError(null)
    setPassword("")
    setConfirmPassword("")
  }

  return (
    <div className="fixed inset-0 flex items-center justify-center bg-[#0a0a0f]">
      {/* Ambient glow */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute left-1/2 top-1/3 h-[500px] w-[500px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-violet-600/10 blur-[120px]" />
        <div className="absolute left-1/3 top-2/3 h-[300px] w-[300px] rounded-full bg-blue-600/10 blur-[100px]" />
      </div>

      <div className="relative z-10 w-full max-w-md px-4">
        {/* Logo */}
        <div className="mb-8 text-center">
          <div className="mb-3 inline-flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-violet-600 to-blue-600 shadow-lg shadow-violet-500/30">
            <BookOpen className="h-7 w-7 text-white" />
          </div>
          <h1 className="text-2xl font-bold text-white">LLM Wiki</h1>
          <p className="mt-1 text-sm text-white/40">Your intelligent knowledge base</p>
        </div>

        {/* Card */}
        <div className="rounded-2xl border border-white/[0.08] bg-white/[0.04] p-6 shadow-2xl backdrop-blur-xl">
          {/* Tabs */}
          <div className="mb-6 flex rounded-xl bg-white/[0.06] p-1">
            <button
              className={`flex-1 rounded-lg py-2 text-sm font-medium transition-all ${
                tab === "login"
                  ? "bg-white/10 text-white shadow"
                  : "text-white/40 hover:text-white/70"
              }`}
              onClick={() => switchTab("login")}
            >
              <LogIn className="mr-1.5 inline h-3.5 w-3.5" />
              Login
            </button>
            <button
              className={`flex-1 rounded-lg py-2 text-sm font-medium transition-all ${
                tab === "register"
                  ? "bg-white/10 text-white shadow"
                  : "text-white/40 hover:text-white/70"
              }`}
              onClick={() => switchTab("register")}
            >
              <UserPlus className="mr-1.5 inline h-3.5 w-3.5" />
              Register
            </button>
          </div>

          <form onSubmit={handleSubmit} className="flex flex-col gap-3">
            {/* Username */}
            <div className="relative">
              <User className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-white/30" />
              <Input
                type="text"
                placeholder="Username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="border-white/10 bg-white/[0.06] pl-9 text-white placeholder:text-white/30 focus:border-violet-500/50 focus:ring-violet-500/20"
                autoComplete="username"
                required
              />
            </div>

            {/* Password */}
            <div className="relative">
              <Lock className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-white/30" />
              <Input
                type={showPassword ? "text" : "password"}
                placeholder="Password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="border-white/10 bg-white/[0.06] pl-9 pr-9 text-white placeholder:text-white/30 focus:border-violet-500/50 focus:ring-violet-500/20"
                autoComplete={tab === "login" ? "current-password" : "new-password"}
                required
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-white/30 hover:text-white/60"
              >
                {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>

            {/* Confirm password (register only) */}
            {tab === "register" && (
              <div className="relative">
                <Lock className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-white/30" />
                <Input
                  type={showPassword ? "text" : "password"}
                  placeholder="Confirm password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  className="border-white/10 bg-white/[0.06] pl-9 text-white placeholder:text-white/30 focus:border-violet-500/50 focus:ring-violet-500/20"
                  autoComplete="new-password"
                  required
                />
              </div>
            )}

            {/* Error message */}
            {error && (
              <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-400">
                {error}
              </div>
            )}

            {/* Submit */}
            <Button
              type="submit"
              disabled={isSubmitting}
              className="mt-1 w-full bg-gradient-to-r from-violet-600 to-blue-600 font-medium text-white hover:from-violet-500 hover:to-blue-500 disabled:opacity-50"
            >
              {isSubmitting ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : tab === "login" ? (
                <LogIn className="mr-2 h-4 w-4" />
              ) : (
                <UserPlus className="mr-2 h-4 w-4" />
              )}
              {isSubmitting ? "Please wait..." : tab === "login" ? "Sign In" : "Create Account"}
            </Button>
          </form>

          {tab === "register" && (
            <p className="mt-4 text-center text-xs text-white/30">
              Username: 3-32 chars, letters/numbers/_/- only
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
