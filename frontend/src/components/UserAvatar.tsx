const DEFAULT_BG = '#64748b'

export function avatarInitial(name: string | null | undefined, username?: string | null) {
  const raw = (name || username || '?').trim()
  return (raw[0] || '?').toUpperCase()
}

export function UserAvatar({
  src,
  name,
  username,
  size = 'md',
  className = '',
}: {
  src?: string | null
  name?: string | null
  username?: string | null
  size?: 'sm' | 'md' | 'lg'
  className?: string
}) {
  const dim =
    size === 'lg' ? 'h-[4.5rem] w-[4.5rem] text-[1.75rem]' : size === 'sm' ? 'h-8 w-8 text-sm' : 'h-10 w-10 text-base'
  const photo = src?.trim()

  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full font-semibold text-white ring-1 ring-[var(--color-border)] ${dim} ${className}`}
      style={photo ? undefined : { background: DEFAULT_BG }}
      aria-hidden
    >
      {photo ? (
        <img src={photo} alt="" className="h-full w-full object-cover" />
      ) : (
        avatarInitial(name, username)
      )}
    </span>
  )
}

/** Resize + compress image for DB storage (JPEG data URL). */
export function fileToAvatarDataUrl(file: File, maxSide = 256, quality = 0.86): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith('image/')) {
      reject(new Error('not_image'))
      return
    }
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      try {
        const scale = Math.min(1, maxSide / Math.max(img.width, img.height))
        const w = Math.max(1, Math.round(img.width * scale))
        const h = Math.max(1, Math.round(img.height * scale))
        const canvas = document.createElement('canvas')
        canvas.width = w
        canvas.height = h
        const ctx = canvas.getContext('2d')
        if (!ctx) {
          reject(new Error('canvas'))
          return
        }
        ctx.drawImage(img, 0, 0, w, h)
        const dataUrl = canvas.toDataURL('image/jpeg', quality)
        URL.revokeObjectURL(url)
        resolve(dataUrl)
      } catch (e) {
        URL.revokeObjectURL(url)
        reject(e)
      }
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('load_failed'))
    }
    img.src = url
  })
}
