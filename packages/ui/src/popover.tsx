import { Popover as PopoverPrimitive } from "radix-ui"
import type * as React from "react"
import { cn } from "./cn"

/** Globo anclado a un botón (calculadora, menú de cuenta). Se cierra con Esc o al tocar fuera. */
export const Popover = PopoverPrimitive.Root
export const PopoverTrigger = PopoverPrimitive.Trigger
export const PopoverClose = PopoverPrimitive.Close

export function PopoverContent({
  className,
  align = "end",
  sideOffset = 8,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Content>) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        data-slot="popover-content"
        align={align}
        sideOffset={sideOffset}
        collisionPadding={8}
        className={cn(
          "z-50 w-80 max-w-[calc(100vw-1rem)] rounded-xl border bg-popover p-4 text-popover-foreground shadow-xl outline-none",
          className,
        )}
        {...props}
      />
    </PopoverPrimitive.Portal>
  )
}
