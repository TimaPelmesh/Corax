import type { Node } from 'reactflow'
import { toPng } from 'html-to-image'
import { absoluteExportBoxes, contentBounds, downloadBlob, exportPixelSize, safeFilename, transformForBounds } from './cables'

function surfaceColor(): string {
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--color-surface').trim()
  if (raw.startsWith('#') || raw.startsWith('rgb')) return raw
  return '#f8f9fb'
}

export async function exportNetworkMapPng(opts: {
  viewportEl: HTMLElement
  nodes: Node[]
  title: string
}): Promise<void> {
  const bounds = contentBounds(absoluteExportBoxes(opts.nodes), 40)
  const pixels = exportPixelSize(bounds, 3, 8192)
  const tf = transformForBounds(bounds, pixels.width, pixels.height)
  const dataUrl = await toPng(opts.viewportEl, {
    backgroundColor: surfaceColor(),
    width: pixels.width,
    height: pixels.height,
    pixelRatio: 1,
    cacheBust: true,
    style: {
      width: `${pixels.width}px`,
      height: `${pixels.height}px`,
      transform: `translate(${tf.x}px, ${tf.y}px) scale(${tf.zoom})`,
      transformOrigin: '0 0',
    },
  })
  const res = await fetch(dataUrl)
  const blob = await res.blob()
  if (!blob.size) throw new Error('empty-png')
  downloadBlob(blob, `${safeFilename(opts.title)}.png`)
}
