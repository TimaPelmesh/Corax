export const MAX_MAP_IMAGE_CHARS = 380_000
export const MAX_MAP_IMAGE_EDGE = 720
export const MAX_MAP_IMAGE_BYTES = 12 * 1024 * 1024

export type CompressedMapImage = {
  src: string
  width: number
  height: number
}

export async function compressMapImage(file: File): Promise<CompressedMapImage> {
  if (!file.type.startsWith('image/')) {
    throw new Error('not-image')
  }
  if (file.size > MAX_MAP_IMAGE_BYTES) {
    throw new Error('too-large')
  }
  const bitmap = await createImageBitmap(file)
  try {
    const scale = Math.min(1, MAX_MAP_IMAGE_EDGE / Math.max(bitmap.width, bitmap.height, 1))
    const width = Math.max(1, Math.round(bitmap.width * scale))
    const height = Math.max(1, Math.round(bitmap.height * scale))
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('not-image')
    ctx.drawImage(bitmap, 0, 0, width, height)
    const preferPng = file.type === 'image/png' || file.type === 'image/webp'
    let src = canvas.toDataURL(preferPng ? 'image/png' : 'image/jpeg', 0.82)
    if (src.length > MAX_MAP_IMAGE_CHARS) {
      src = canvas.toDataURL('image/jpeg', 0.7)
    }
    if (src.length > MAX_MAP_IMAGE_CHARS) {
      throw new Error('too-large')
    }
    return { src, width, height }
  } finally {
    bitmap.close()
  }
}
