import type { Node } from 'reactflow'
import { toBlob } from 'html-to-image'
import { absoluteExportBoxes, contentBounds, downloadBlob, exportPixelSize, safeFilename, transformForBounds } from './cables'

const COLOR_PROPS = [
  'color',
  'background-color',
  'border-color',
  'border-top-color',
  'border-right-color',
  'border-bottom-color',
  'border-left-color',
  'outline-color',
  'fill',
  'stroke',
] as const

function surfaceColor(): string {
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--color-surface').trim()
  if (raw.startsWith('#') || raw.startsWith('rgb')) return raw
  return '#f8f9fb'
}

function flattenComputedColors(root: HTMLElement): Array<{ el: HTMLElement | SVGElement; cssText: string }> {
  const saved: Array<{ el: HTMLElement | SVGElement; cssText: string }> = []
  const nodes: Array<HTMLElement | SVGElement> = [root]
  root.querySelectorAll<HTMLElement | SVGElement>('*').forEach((el) => nodes.push(el))
  for (const el of nodes) {
    saved.push({ el, cssText: el.getAttribute('style') || '' })
    const cs = getComputedStyle(el)
    for (const prop of COLOR_PROPS) {
      const value = cs.getPropertyValue(prop)
      if (value && (value.startsWith('rgb') || value.startsWith('#') || value === 'transparent' || value === 'none')) {
        el.style.setProperty(prop, value)
      }
    }
  }
  return saved
}

function restoreStyles(saved: Array<{ el: HTMLElement | SVGElement; cssText: string }>): void {
  for (const { el, cssText } of saved) {
    if (cssText) el.setAttribute('style', cssText)
    else el.removeAttribute('style')
  }
}

function skipExportNoise(node: HTMLElement): boolean {
  const cls = node.classList
  if (!cls) return true
  if (cls.contains('react-flow__minimap')) return false
  if (cls.contains('react-flow__controls')) return false
  if (cls.contains('react-flow__attribution')) return false
  if (cls.contains('react-flow__panel')) return false
  if (cls.contains('network-map-resizer')) return false
  if (cls.contains('network-map-inspector-overlay')) return false
  return true
}

async function blobFromViewport(
  viewportEl: HTMLElement,
  width: number,
  height: number,
  tf: { x: number; y: number; zoom: number },
): Promise<Blob> {
  const blob = await toBlob(viewportEl, {
    backgroundColor: surfaceColor(),
    width,
    height,
    canvasWidth: width,
    canvasHeight: height,
    pixelRatio: 1,
    cacheBust: false,
    skipFonts: true,
    skipAutoScale: true,
    filter: skipExportNoise,
    imagePlaceholder: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    style: {
      width: `${width}px`,
      height: `${height}px`,
      transform: `translate(${tf.x}px, ${tf.y}px) scale(${tf.zoom})`,
      transformOrigin: '0 0',
    },
  })
  if (!blob || blob.size < 32) throw new Error('empty-png')
  return blob
}

export async function exportNetworkMapPng(opts: {
  viewportEl: HTMLElement
  nodes: Node[]
  title: string
}): Promise<void> {
  const boxes = absoluteExportBoxes(opts.nodes)
  const bounds = contentBounds(boxes, 40)
  const attempts = [
    exportPixelSize(bounds, 3, 6144),
    exportPixelSize(bounds, 2, 4096),
    exportPixelSize(bounds, 1, 2048),
  ]
  const saved = flattenComputedColors(opts.viewportEl)
  let last: unknown = null
  try {
    for (const pixels of attempts) {
      const tf = transformForBounds(bounds, pixels.width, pixels.height)
      try {
        const blob = await blobFromViewport(opts.viewportEl, pixels.width, pixels.height, tf)
        downloadBlob(blob, `${safeFilename(opts.title)}.png`)
        return
      } catch (err) {
        last = err
      }
    }
  } finally {
    restoreStyles(saved)
  }
  throw last instanceof Error ? last : new Error('empty-png')
}
