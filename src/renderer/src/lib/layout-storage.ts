/** Persist panel sizes. localStorage can throw or be empty (private mode, cleared data), so never trust it. */
export function loadLayout(key: string): Record<string, number> | undefined {
  try {
    const raw = localStorage.getItem(`layout:${key}`)
    const parsed = raw ? JSON.parse(raw) : undefined
    return parsed && typeof parsed === 'object' ? parsed : undefined
  } catch {
    return undefined
  }
}

export function saveLayout(key: string, layout: Record<string, number>): void {
  try {
    localStorage.setItem(`layout:${key}`, JSON.stringify(layout))
  } catch {
    /* ignore */
  }
}
