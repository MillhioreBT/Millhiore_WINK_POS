/** «Chrome en Windows», «Safari en iPhone»… a partir del agente de usuario del navegador. */
export function describeAgent(agent: string | null): string {
  if (!agent) return "Equipo desconocido"
  const system = /Android/i.test(agent)
    ? "Android"
    : /iPhone|iPad|iPod/i.test(agent)
      ? "iPhone"
      : /Windows/i.test(agent)
        ? "Windows"
        : /Mac OS X|Macintosh/i.test(agent)
          ? "Mac"
          : /Linux/i.test(agent)
            ? "Linux"
            : null
  const browser = /Edg\//.test(agent)
    ? "Edge"
    : /OPR\/|Opera/.test(agent)
      ? "Opera"
      : /Firefox\//.test(agent)
        ? "Firefox"
        : /Chrome\/|CriOS\//.test(agent)
          ? "Chrome"
          : /Safari\//.test(agent)
            ? "Safari"
            : null
  if (browser && system) return `${browser} en ${system}`
  return browser ?? system ?? "Equipo desconocido"
}

export const isPhone = (agent: string | null) =>
  !!agent && /Android|iPhone|iPad|iPod|Mobile/i.test(agent)
