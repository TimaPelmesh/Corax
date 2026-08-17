/** Фото «на месте» для объектов карты этажа — хранятся в meta.place_photos_json как JSON. */

export type PlacePhoto = {
  id: string
  dataUrl: string
  caption: string
}

export const MAX_PLACE_PHOTOS = 6

export function parsePlacePhotosJson(raw: string | null | undefined): PlacePhoto[] {
  if (!raw || !String(raw).trim()) return []
  try {
    const data = JSON.parse(String(raw)) as unknown
    if (!Array.isArray(data)) return []
    const out: PlacePhoto[] = []
    for (const item of data) {
      if (out.length >= MAX_PLACE_PHOTOS) break
      if (!item || typeof item !== 'object') continue
      const o = item as Record<string, unknown>
      const dataUrl = typeof o.dataUrl === 'string' ? o.dataUrl : ''
      if (!dataUrl.startsWith('data:image/')) continue
      out.push({
        id:
          typeof o.id === 'string' && o.id.trim()
            ? o.id.trim().slice(0, 64)
            : `ph-${Math.random().toString(36).slice(2, 11)}`,
        dataUrl,
        caption: typeof o.caption === 'string' ? o.caption.trim().slice(0, 240) : '',
      })
    }
    return out
  } catch {
    return []
  }
}

export function serializePlacePhotos(photos: PlacePhoto[]): string {
  return JSON.stringify(
    photos.map((p) => ({
      id: p.id,
      dataUrl: p.dataUrl,
      caption: p.caption,
    })),
  )
}

/** Уменьшает сторону и кодирует JPEG; при необходимости снижает качество, чтобы уложиться в разумный размер data URL. */
export async function compressImageFileToJpegDataUrl(file: File, maxEdge = 1280): Promise<string> {
  if (!file.type.startsWith('image/')) {
    throw new Error('Выберите файл изображения')
  }
  const bitmap = await createImageBitmap(file)
  try {
    let { width, height } = bitmap
    const scale = Math.min(1, maxEdge / Math.max(width, height, 1))
    const w = Math.max(1, Math.round(width * scale))
    const h = Math.max(1, Math.round(height * scale))
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Не удалось подготовить canvas')
    ctx.drawImage(bitmap, 0, 0, w, h)
    const targetApprox = 380_000
    let q = 0.88
    for (let i = 0; i < 10; i++) {
      const url = canvas.toDataURL('image/jpeg', q)
      const approxBytes = Math.round((url.length * 3) / 4)
      if (approxBytes <= targetApprox || q <= 0.42) return url
      q -= 0.06
    }
    return canvas.toDataURL('image/jpeg', 0.42)
  } finally {
    bitmap.close()
  }
}

export function firstPlacePhotoDataUrl(raw: string | null | undefined): string | null {
  const list = parsePlacePhotosJson(raw)
  return list[0]?.dataUrl ?? null
}
