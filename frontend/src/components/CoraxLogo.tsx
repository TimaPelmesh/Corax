type Props = {
  className?: string
  variant?: 'full' | 'icon' | 'wordmark' | 'bird'
  animated?: boolean
  alt?: string
}

const LOGO_SRC = '/logo.png'

function useFallbackLogo(event: React.SyntheticEvent<HTMLImageElement>) {
  event.currentTarget.onerror = null
  event.currentTarget.src = '/favicon.svg'
}

export function CoraxLogo({
  className = '',
  variant = 'full',
  animated = false,
  alt = 'Corax',
}: Props) {
  if (variant === 'icon' || variant === 'bird') {
    return (
      <div
        className={[
          variant === 'bird' ? 'login-bird' : 'relative h-full w-full overflow-hidden',
          animated ? 'login-logo-mark' : '',
          className,
        ]
          .filter(Boolean)
          .join(' ')}
        role={alt ? 'img' : undefined}
        aria-label={alt || undefined}
      >
        <img
          src={LOGO_SRC}
          alt=""
          aria-hidden
          decoding="async"
          onError={useFallbackLogo}
          draggable={false}
          className={
            variant === 'bird'
              ? 'login-bird-img'
              : 'pointer-events-none absolute left-1/2 top-0 h-[70%] w-[70%] max-w-none -translate-x-1/2 object-contain mix-blend-lighten select-none'
          }
        />
      </div>
    )
  }

  if (variant === 'wordmark') {
    return (
      <span
        className={['brand-wordmark select-none', className].filter(Boolean).join(' ')}
        aria-label={alt}
      >
        Corax
      </span>
    )
  }

  return (
    <img
      src={LOGO_SRC}
      alt={alt}
      width={400}
      height={500}
      decoding="async"
      onError={useFallbackLogo}
      draggable={false}
      className={[
        'login-logo-img block h-auto w-[min(72vw,280px)] shrink-0 select-none sm:w-[300px]',
        animated ? 'login-logo-mark' : '',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    />
  )
}
