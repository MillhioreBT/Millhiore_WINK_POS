import { QueryClientProvider } from "@tanstack/react-query"
import { RouterProvider } from "@tanstack/react-router"
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { Toaster } from "sonner"
import { queryClient } from "./lib/queries"
import { router } from "./router"
import "./styles.css"

const root = document.getElementById("root")
if (!root) throw new Error("Falta el elemento #root")

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
      {/* Debajo de la barra superior (y de la tasa en el celular), para no tapar la navegación. */}
      <Toaster
        richColors
        position="top-center"
        closeButton
        offset={{ top: 64 }}
        mobileOffset={{ top: 104 }}
      />
    </QueryClientProvider>
  </StrictMode>,
)
