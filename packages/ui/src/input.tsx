import type * as React from "react"
import { cn } from "./cn"

const field =
  "flex h-10 w-full min-w-0 rounded-md border border-input bg-card px-3 py-2 text-sm shadow-xs transition-colors outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20"

export function Input({ className, type = "text", ...props }: React.ComponentProps<"input">) {
  return <input type={type} data-slot="input" className={cn(field, className)} {...props} />
}

/** Lista desplegable nativa: accesible, rápida en tablets viejas y con el teclado del sistema. */
export function NativeSelect({ className, ...props }: React.ComponentProps<"select">) {
  return (
    <select data-slot="select" className={cn(field, "cursor-pointer pr-8", className)} {...props} />
  )
}

export function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea data-slot="textarea" className={cn(field, "h-auto min-h-20", className)} {...props} />
  )
}
