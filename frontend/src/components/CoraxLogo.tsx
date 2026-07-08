type Props = {
  className?: string
  variant?: 'full' | 'icon'
  animated?: boolean
  alt?: string
}

const LOGO_SRC = '/logo.png'

export function CoraxLogo({
  className = '',
  variant = 'full',
  animated = false,
  alt = 'CORAX',
}: Props) {
  const isIcon = variant === 'icon'

  if (isIcon) {
    return (
      <div
        className={['relative h-full w-full overflow-hidden', className].filter(Boolean).join(' ')}
        role={alt ? 'img' : undefined}
        aria-label={alt || undefined}
      >
        <img
          src={LOGO_SRC}
          alt=""
          aria-hidden
          decoding="async"
          draggable={false}
          className="pointer-events-none absolute left-1/2 top-[4%] h-[168%] w-[168%] max-w-none -translate-x-1/2 select-none"
        />
      </div>
    )
  }

  return (
    <img
      src={LOGO_SRC}
      alt={alt}
      width={400}
      height={500}
      decoding="async"
      className={[
        'block h-auto w-[min(72vw,320px)] shrink-0 select-none sm:w-[360px] lg:w-[400px]',
        animated ? 'login-logo-mark' : '',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
      draggable={false}
    />
  )
}
