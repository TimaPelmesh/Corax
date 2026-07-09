type Props = {
  className?: string
  variant?: 'full' | 'icon' | 'wordmark'
  animated?: boolean
  alt?: string
}

const LOGO_SRC = '/logo.png'
const WORDMARK_SRC = '/text.png'

export function CoraxLogo({
  className = '',
  variant = 'full',
  animated = false,
  alt = 'CORAX',
}: Props) {
  const isIcon = variant === 'icon'
  const isWordmark = variant === 'wordmark'

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
          className="pointer-events-none absolute left-1/2 top-0 h-[70%] w-[70%] max-w-none -translate-x-1/2 object-contain mix-blend-lighten select-none"
        />
      </div>
    )
  }

  if (isWordmark) {
    return (
      <img
        src={WORDMARK_SRC}
        alt={alt}
        width={840}
        height={174}
        decoding="async"
        draggable={false}
        className={[
          'block h-8 w-auto max-w-full shrink-0 select-none object-contain sm:h-9',
          className,
        ]
          .filter(Boolean)
          .join(' ')}
      />
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
        'block h-auto w-[min(88vw,340px)] shrink-0 select-none sm:w-[380px] md:w-[420px] lg:w-[480px] xl:w-[520px]',
        animated ? 'login-logo-mark' : '',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
      draggable={false}
    />
  )
}
