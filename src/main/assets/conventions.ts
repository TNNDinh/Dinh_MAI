import type { AssetKind, ProjectType } from '../../shared/ipc'

/**
 * Where generated pictures go inside a project, following the usual layout of each engine/framework so the files
 * are picked up without moving them. The folder is created on first use.
 */
const KIND_FOLDER: Record<AssetKind, string> = {
  sprite: 'sprites',
  texture: 'textures',
  background: 'backgrounds',
  ui: 'ui',
  icon: 'icons',
  concept: 'concepts',
  other: 'other'
}

const UNITY_FOLDER: Record<AssetKind, string> = {
  sprite: 'Sprites',
  texture: 'Textures',
  background: 'Backgrounds',
  ui: 'UI',
  icon: 'Icons',
  concept: 'Concepts',
  other: 'Other'
}

export function assetFolder(type: ProjectType | string, kind: AssetKind): string {
  switch (type) {
    case 'unity':
      return `Assets/${UNITY_FOLDER[kind]}`
    case 'unreal':
      // Unreal imports from outside Content/, so source pictures live next to it.
      return `SourceArt/${KIND_FOLDER[kind]}`
    case 'react':
    case 'nextjs':
      return `public/assets/${KIND_FOLDER[kind]}`
    default:
      return `assets/${KIND_FOLDER[kind]}`
  }
}

/** Lower-case words joined by dashes; safe on every platform. Never empty. */
export function slugify(text: string, fallback = 'image', maxLen = 40): string {
  const slug = text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLen)
    .replace(/-+$/g, '')
  return slug || fallback
}

/** A file name stem from the user's chosen name, else the first words of the prompt, else the kind. */
export function suggestName(name: string | undefined, prompt: string, kind: AssetKind): string {
  const explicit = name?.trim()
  if (explicit) return slugify(explicit, kind)
  const words = prompt.trim().split(/\s+/).slice(0, 6).join(' ')
  return slugify(words, kind)
}

/** `folder/stem.ext`, with `-2`, `-3`, … appended until `exists` says the path is free. */
export function uniquePath(folder: string, stem: string, ext: string, exists: (rel: string) => boolean): string {
  const prefix = folder ? `${folder}/` : ''
  for (let i = 1; i < 10_000; i++) {
    const rel = `${prefix}${i === 1 ? stem : `${stem}-${i}`}.${ext}`
    if (!exists(rel)) return rel
  }
  throw new Error('Could not find a free file name.')
}

/** Guesses the asset kind for a task from its text; used when an agent produces a picture without saying what it is. */
export function guessKind(text: string): AssetKind {
  const t = text.toLowerCase()
  if (/\b(icon|icons|glyph)\b/.test(t)) return 'icon'
  if (/\b(sprite|sprites|character|enemy|player|hero|monster|item|sprite sheet)\b/.test(t)) return 'sprite'
  if (/\b(texture|tileable|tiling|seamless|material|pattern)\b/.test(t)) return 'texture'
  if (/\b(background|backdrop|landscape|scene|environment|skybox|parallax)\b/.test(t)) return 'background'
  if (/\b(ui|hud|button|panel|menu|frame|health bar|logo)\b/.test(t)) return 'ui'
  return 'concept'
}
