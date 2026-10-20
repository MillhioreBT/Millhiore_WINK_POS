import { type ClassValue, clsx } from "clsx"
import { twMerge } from "tailwind-merge"

/** Une clases condicionales y resuelve conflictos de Tailwind (la última gana). */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
