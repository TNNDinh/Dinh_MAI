import { ImageOff } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { AssetItem } from '../../../../shared/ipc'
import { cx } from '../ui'

// Previews are decoded and scaled in the main process; the data URL is cached per file version.
const cache = new Map<string, string | null>()
const MAX_CACHED = 300

/** A picture from the asset library on a checkerboard so transparency is visible. */
export function AssetImage({ asset, max, className }: { asset: AssetItem; max: number; className?: string }) {
  const key = `${asset.id}:${asset.bytes}:${max}`
  const [src, setSrc] = useState<string | null | undefined>(() => cache.get(key))
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    setFailed(false)
    if (!asset.exists) return setSrc(null)
    if (cache.has(key)) return setSrc(cache.get(key))
    setSrc(undefined)
    let live = true
    void window.api.invoke('assets:preview', { id: asset.id, max }).then(
      (url) => {
        if (cache.size >= MAX_CACHED) cache.delete(cache.keys().next().value as string)
        cache.set(key, url)
        if (live) setSrc(url)
      },
      () => live && setFailed(true)
    )
    return () => {
      live = false
    }
  }, [key, asset.exists, asset.id, max])

  return (
    <div className={cx('checker flex items-center justify-center overflow-hidden', className)} data-asset-image={asset.name}>
      {src ? (
        <img src={src} alt={asset.name} draggable={false} className="max-h-full max-w-full object-contain" style={{ imageRendering: 'auto' }} />
      ) : (
        <span className="flex flex-col items-center gap-1 p-2 text-center text-[11px] text-faint">
          <ImageOff size={18} />
          {!asset.exists ? 'File missing' : failed || src === null ? 'No preview' : 'Loading…'}
        </span>
      )}
    </div>
  )
}
