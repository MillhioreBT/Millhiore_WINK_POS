import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { CatalogApp } from "./CatalogApp"
import "./catalog.css"

// El catálogo en línea es una página aparte de la app: la ve cualquiera, sin entrar.
const root = document.getElementById("root")
if (!root) throw new Error("Falta el elemento #root")

createRoot(root).render(
  <StrictMode>
    <CatalogApp />
  </StrictMode>,
)
