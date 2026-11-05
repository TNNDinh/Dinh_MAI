import { ASSET_KINDS, type AssetItem, type AssetKind } from '../../shared/ipc'
import type { AgentTool, ToolContext } from './tools'

const MAX_COUNT_PER_CALL = 4
const KIND_LIST = ASSET_KINDS.map((k) => k.value)

const need = (ctx: ToolContext) => {
  if (!ctx.assets) throw new Error('Picture generation is not available.')
  return ctx.assets
}

export function describeAsset(a: AssetItem): string {
  const dims = a.width && a.height ? `${a.width}x${a.height}` : 'size unknown'
  return `${a.path}  (${a.kind}, ${dims}${a.transparent ? ', transparent' : ''}, id ${a.id})`
}

const generateImage: AgentTool = {
  def: {
    name: 'generate_image',
    description: `Create a picture with the team's image-generation model and save it in the project's asset folder (sprites, textures, backgrounds, UI, icons, concept art). Every picture costs money and takes up to a minute: ask only for what the task needs, ask for several variations in one call with count (max ${MAX_COUNT_PER_CALL}) rather than several calls, and do not retry the same failing request. The prompt must be self-contained: subject, art style, palette, camera/view, background.`,
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'A complete description of the picture.' },
        kind: { type: 'string', enum: KIND_LIST, description: 'What the picture is for; decides the folder.' },
        name: { type: 'string', description: 'Short file name without extension, e.g. "goblin-idle".' },
        size: { type: 'string', description: 'Requested size like "1024x1024". The model uses the nearest size it supports.' },
        transparent: { type: 'boolean', description: 'True when the picture needs a transparent background (sprites, icons). Models without native transparency are post-processed, which only works for a flat background.' },
        count: { type: 'integer', description: `1 to ${MAX_COUNT_PER_CALL}. Default 1.` },
        reference_asset_id: { type: 'string', description: 'Id of an existing asset to edit or vary (only if the model supports editing).' }
      },
      required: ['prompt']
    }
  },
  allowed: (a) => a.permissions.generateImages,
  execute: async (ctx, args) => {
    const assets = need(ctx)
    const target = ctx.imageTarget
    if (!target) throw new Error('This project has no working Image Generator agent, so no picture can be made. Describe the picture you need in your report instead and say that an image model has to be connected.')
    if (typeof args.prompt !== 'string' || !args.prompt.trim()) throw new Error('prompt is required.')
    const count = typeof args.count === 'number' && Number.isFinite(args.count) ? Math.min(Math.max(Math.trunc(args.count), 1), MAX_COUNT_PER_CALL) : 1
    const kind: AssetKind = typeof args.kind === 'string' && KIND_LIST.includes(args.kind as AssetKind) ? (args.kind as AssetKind) : 'concept'
    const r = await assets.generate(
      {
        requestId: '',
        projectId: ctx.projectId,
        connectionId: target.connectionId,
        model: target.model,
        prompt: args.prompt,
        kind,
        name: typeof args.name === 'string' ? args.name : undefined,
        size: typeof args.size === 'string' && args.size ? args.size : undefined,
        count,
        transparent: args.transparent === true,
        referenceAssetId: typeof args.reference_asset_id === 'string' && args.reference_asset_id ? args.reference_asset_id : undefined
      },
      { runId: ctx.runId, taskId: ctx.taskId, agent: { id: ctx.agent.id, name: ctx.agent.name }, signal: ctx.signal }
    )
    return [`Created ${r.assets.length} picture${r.assets.length === 1 ? '' : 's'} with ${target.model}:`, ...r.assets.map((a) => `- ${describeAsset(a)}`), ...r.notes.map((n) => `Note: ${n}`)].join('\n')
  }
}

const listAssets: AgentTool = {
  def: {
    name: 'list_assets',
    description: 'List the pictures already generated for this project (path, kind, size, id, and the prompt they came from), newest first. Use it to reuse or vary existing art instead of generating again.',
    parameters: { type: 'object', properties: { kind: { type: 'string', enum: KIND_LIST } } }
  },
  allowed: (a) => a.permissions.generateImages || a.permissions.readFiles,
  execute: (ctx, args) => {
    const assets = need(ctx)
    const kind = typeof args.kind === 'string' && KIND_LIST.includes(args.kind as AssetKind) ? (args.kind as AssetKind) : null
    const list = assets.list(ctx.projectId, kind).filter((a) => a.exists)
    if (list.length === 0) return 'No pictures have been generated for this project yet.'
    const shown = list.slice(0, 40)
    return shown.map((a) => `${describeAsset(a)}${a.prompt ? `\n   prompt: ${a.prompt.length > 160 ? `${a.prompt.slice(0, 160)}…` : a.prompt}` : ''}`).join('\n') + (list.length > shown.length ? `\n[${list.length - shown.length} older pictures not shown]` : '')
  }
}

export const ASSET_TOOLS: AgentTool[] = [generateImage, listAssets]
