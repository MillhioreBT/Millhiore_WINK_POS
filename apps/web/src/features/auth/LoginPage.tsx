import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Field,
  Input,
} from "@millhiore/ui"
import { useNavigate } from "@tanstack/react-router"
import { LogInIcon } from "lucide-react"
import { useState } from "react"
import { errorMessage } from "../../lib/api"
import { signIn } from "../../lib/session"

export function LoginPage() {
  const navigate = useNavigate()
  const [username, setUsername] = useState("")
  const [password, setPassword] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await signIn(username.trim().toLowerCase(), password)
      await navigate({ to: "/" })
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="grid min-h-dvh place-items-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center">
          <img src="/favicon.svg" alt="" className="mx-auto mb-2 size-12" />
          <CardTitle className="text-xl">Millhiore WINK POS</CardTitle>
          <CardDescription>Entra con tu usuario</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="grid grid-cols-1 gap-4">
            <Field label="Usuario" htmlFor="username">
              <Input
                id="username"
                autoComplete="username"
                autoCapitalize="none"
                autoFocus
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                required
              />
            </Field>
            <Field label="Contraseña" htmlFor="password" error={error}>
              <Input
                id="password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                aria-invalid={error ? true : undefined}
                required
              />
            </Field>
            <Button type="submit" size="lg" disabled={busy}>
              <LogInIcon /> {busy ? "Entrando…" : "Entrar"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
