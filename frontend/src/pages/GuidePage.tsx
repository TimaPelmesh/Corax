import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useLocale } from '../i18n/LocaleContext'
import { guideCopy, type GuideSection } from '../i18n/guideContent'

export function GuidePage() {
  const { locale } = useLocale()
  const copy = guideCopy(locale)
  const [searchParams, setSearchParams] = useSearchParams()
  const initialSection = searchParams.get('section') || copy.sections[0]?.id || 'start'
  const [active, setActive] = useState(initialSection)
  const [query, setQuery] = useState('')
  const sectionRefs = useRef<Record<string, HTMLElement | null>>({})

  const sections = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return copy.sections
    return copy.sections
      .map((section) => {
        const titleHit = section.title.toLowerCase().includes(q) || section.summary.toLowerCase().includes(q)
        const steps = section.steps.filter(
          (step) => step.title.toLowerCase().includes(q) || step.body.toLowerCase().includes(q),
        )
        if (titleHit) return section
        if (steps.length === 0) return null
        return { ...section, steps }
      })
      .filter((s): s is GuideSection => s != null)
  }, [copy.sections, query])

  useEffect(() => {
    const wanted = searchParams.get('section')
    if (!wanted) return
    if (!copy.sections.some((s) => s.id === wanted)) return
    setActive(wanted)
    const el = document.getElementById(wanted)
    if (el) {
      requestAnimationFrame(() => el.scrollIntoView({ behavior: 'smooth', block: 'start' }))
    }
  }, [searchParams, copy.sections])

  useEffect(() => {
    const nodes = sections
      .map((s) => sectionRefs.current[s.id])
      .filter((n): n is HTMLElement => Boolean(n))
    if (nodes.length === 0) return

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio)
        const top = visible[0]?.target as HTMLElement | undefined
        if (top?.id) setActive(top.id)
      },
      { rootMargin: '-20% 0px -55% 0px', threshold: [0.15, 0.35, 0.6] },
    )
    for (const node of nodes) observer.observe(node)
    return () => observer.disconnect()
  }, [sections])

  function goToSection(id: string) {
    setActive(id)
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        next.set('section', id)
        return next
      },
      { replace: true },
    )
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  return (
    <div className="mx-auto max-w-5xl pb-12">
      <label className="mb-5 block max-w-md">
        <span className="sr-only">{copy.searchPlaceholder}</span>
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={copy.searchPlaceholder}
          className="app-input w-full text-sm"
        />
      </label>

      <div className="grid gap-6 lg:grid-cols-[13.5rem_minmax(0,1fr)] lg:gap-8">
        <nav
          className="guide-toc lg:sticky lg:top-20 lg:self-start lg:max-h-[calc(100vh-7rem)] lg:overflow-y-auto lg:overscroll-contain lg:pr-1"
          aria-label={copy.toc}
        >
          <p className="mb-1 hidden px-2.5 text-[10px] font-bold uppercase tracking-[0.16em] text-[var(--color-fg-subtle)] lg:block">
            {copy.toc}
          </p>
          <ul className="guide-toc-list flex gap-1 overflow-x-auto overscroll-x-contain pb-1 [scrollbar-width:thin] lg:flex-col lg:gap-px lg:overflow-visible lg:pb-0">
            {sections.map((s) => {
              const selected = active === s.id
              return (
                <li key={s.id} className="shrink-0 lg:w-full">
                  <button
                    type="button"
                    onClick={() => goToSection(s.id)}
                    className={`group relative flex min-h-9 w-full touch-manipulation items-center gap-2 overflow-hidden rounded-md border border-transparent px-2.5 py-1 text-left text-[13px] font-medium transition-colors active:scale-[0.99] lg:min-h-[28px] ${
                      selected
                        ? 'bg-[var(--color-primary-muted)] text-[var(--color-fg)]'
                        : 'bg-[var(--color-surface)] text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-fg)] lg:bg-transparent'
                    }`}
                  >
                    <span
                      className={`relative flex h-5 w-5 shrink-0 items-center justify-center rounded-md transition ${
                        selected
                          ? 'text-[var(--color-primary)]'
                          : 'text-[var(--color-fg-subtle)] group-hover:text-[var(--color-fg)]'
                      }`}
                      aria-hidden
                    >
                      <span
                        className={`h-1.5 w-1.5 rounded-full transition ${
                          selected ? 'bg-[var(--color-primary)]' : 'bg-[var(--color-border-strong)]'
                        }`}
                      />
                    </span>
                    <span className="relative min-w-0 flex-1 truncate whitespace-nowrap">{s.title}</span>
                  </button>
                </li>
              )
            })}
          </ul>
        </nav>

        <div className="min-w-0 space-y-5">
          {sections.length === 0 ? (
            <p className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] px-5 py-8 text-center text-sm text-[var(--color-fg-muted)]">
              {copy.searchEmpty}
            </p>
          ) : (
            sections.map((section) => (
              <section
                key={section.id}
                id={section.id}
                ref={(el) => {
                  sectionRefs.current[section.id] = el
                }}
                className="scroll-mt-24 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] px-5 py-5 sm:px-6 sm:py-6"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h2 className="text-base font-semibold tracking-tight text-[var(--color-fg)] sm:text-lg">
                    {section.title}
                  </h2>
                </div>
                <p className="mt-1.5 text-sm leading-relaxed text-[var(--color-fg-muted)]">{section.summary}</p>

                <ol className="mt-5 space-y-4">
                  {section.steps.map((step, i) => (
                    <li key={step.title} className="flex gap-3.5 text-sm leading-relaxed">
                      <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[var(--color-primary-muted)] text-[11px] font-semibold tabular-nums text-[var(--color-primary)]">
                        {i + 1}
                      </span>
                      <div className="min-w-0 pt-0.5">
                        <p className="font-medium text-[var(--color-fg)]">{step.title}</p>
                        <p className="mt-1 whitespace-pre-wrap text-[var(--color-fg-muted)]">{step.body}</p>
                      </div>
                    </li>
                  ))}
                </ol>

                {section.links && section.links.length > 0 ? (
                  <div className="mt-5 flex flex-wrap gap-2 border-t border-[var(--color-border)] pt-4">
                    {section.links.map((link) => (
                      <Link
                        key={link.to}
                        to={link.to}
                        className="inline-flex items-center gap-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-muted)]/50 px-2.5 py-1 text-xs font-medium text-[var(--color-primary)] transition hover:bg-[var(--color-surface-muted)]"
                      >
                        <span className="text-[var(--color-fg-subtle)]">{copy.openLabel}</span>
                        {link.label}
                        <span aria-hidden className="text-[var(--color-fg-subtle)]">
                          →
                        </span>
                      </Link>
                    ))}
                  </div>
                ) : null}
              </section>
            ))
          )}

          <aside className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-primary-muted)]/35 px-5 py-4 text-sm leading-relaxed text-[var(--color-fg)]">
            <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--color-primary)]">
              {copy.tip}
            </p>
            <p className="mt-1.5 text-[var(--color-fg-muted)]">{copy.tipBody}</p>
          </aside>
        </div>
      </div>
    </div>
  )
}
