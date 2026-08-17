import { Fragment, type ReactNode } from 'react'

/** Inline: **bold**, *italic*, `code`, ~~strike~~ */
function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = []
  const re =
    /(\*\*[^*\n]+?\*\*|\*[^*\n]+?\*|`[^`\n]+`|~~[^~\n]+~~|\[[^\]]+\]\([^)\s]+\))/g
  let last = 0
  let m: RegExpExecArray | null
  let i = 0
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) {
      nodes.push(<Fragment key={`${keyPrefix}-t${i++}`}>{text.slice(last, m.index)}</Fragment>)
    }
    const tok = m[0]
    if (tok.startsWith('**') && tok.endsWith('**')) {
      nodes.push(
        <strong key={`${keyPrefix}-b${i++}`} className="font-semibold text-[var(--color-fg)]">
          {tok.slice(2, -2)}
        </strong>,
      )
    } else if (tok.startsWith('~~') && tok.endsWith('~~')) {
      nodes.push(
        <span key={`${keyPrefix}-s${i++}`} className="line-through opacity-70">
          {tok.slice(2, -2)}
        </span>,
      )
    } else if (tok.startsWith('*') && tok.endsWith('*')) {
      nodes.push(
        <em key={`${keyPrefix}-i${i++}`} className="italic">
          {tok.slice(1, -1)}
        </em>,
      )
    } else if (tok.startsWith('`') && tok.endsWith('`')) {
      nodes.push(
        <code
          key={`${keyPrefix}-c${i++}`}
          className="rounded bg-[var(--color-bg-muted)] px-1 py-0.5 font-mono text-[12px] text-[var(--color-fg)]"
        >
          {tok.slice(1, -1)}
        </code>,
      )
    } else if (tok.startsWith('[')) {
      const link = tok.match(/^\[([^\]]+)\]\(([^)\s]+)\)$/)
      if (link) {
        nodes.push(
          <a
            key={`${keyPrefix}-a${i++}`}
            href={link[2]}
            target="_blank"
            rel="noreferrer noopener"
            className="text-[var(--color-primary)] underline-offset-2 hover:underline"
          >
            {link[1]}
          </a>,
        )
      } else {
        nodes.push(<Fragment key={`${keyPrefix}-t${i++}`}>{tok}</Fragment>)
      }
    }
    last = m.index + tok.length
  }
  if (last < text.length) {
    nodes.push(<Fragment key={`${keyPrefix}-t${i++}`}>{text.slice(last)}</Fragment>)
  }
  return nodes
}

type Block =
  | { type: 'heading'; level: 1 | 2 | 3 | 4; text: string }
  | { type: 'ul'; items: string[] }
  | { type: 'ol'; items: string[] }
  /** Numbered step that introduces a bullet list — show as bold title, no "1." */
  | { type: 'step'; text: string }
  | { type: 'hr' }
  | { type: 'code'; lang: string; text: string }
  | { type: 'p'; text: string }

function parseBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n/g, '\n').split('\n')
  const blocks: Block[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]

    if (/^\s*```/.test(line)) {
      const lang = line.replace(/^\s*```/, '').trim()
      const body: string[] = []
      i += 1
      while (i < lines.length && !/^\s*```/.test(lines[i])) {
        body.push(lines[i])
        i += 1
      }
      if (i < lines.length) i += 1
      blocks.push({ type: 'code', lang, text: body.join('\n') })
      continue
    }

    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      blocks.push({ type: 'hr' })
      i += 1
      continue
    }

    // Допускаем ###Заголовок без пробела — модели часто так ломают markdown.
    const h = line.match(/^\s*(#{1,4})\s*(.+?)\s*$/)
    if (h && h[2] && !h[2].startsWith('#')) {
      blocks.push({
        type: 'heading',
        level: Math.min(h[1].length, 4) as 1 | 2 | 3 | 4,
        text: h[2],
      })
      i += 1
      continue
    }

    if (/^\s*[-*•]\s+/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^\s*[-*•]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*•]\s+/, ''))
        i += 1
      }
      blocks.push({ type: 'ul', items })
      continue
    }

    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+[.)]\s+/, ''))
        i += 1
      }
      blocks.push({ type: 'ol', items })
      continue
    }

    if (!line.trim()) {
      i += 1
      continue
    }

    const para: string[] = [line]
    i += 1
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^\s*#{1,4}\s/.test(lines[i]) &&
      !/^\s*[-*•]\s+/.test(lines[i]) &&
      !/^\s*\d+[.)]\s+/.test(lines[i]) &&
      !/^\s*```/.test(lines[i]) &&
      !/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(lines[i])
    ) {
      para.push(lines[i])
      i += 1
    }
    blocks.push({ type: 'p', text: para.join('\n') })
  }
  return demoteOlBeforeBullets(blocks)
}

/**
 * Model often emits: 1. Title / 2. Title: then a bullet list, then again 1. Title.
 * Each HTML <ol> restarts at 1 — looks broken. Turn those step headers into
 * unnumbered bold lines when they introduce a marked list.
 */
function demoteOlBeforeBullets(blocks: Block[]): Block[] {
  const out: Block[] = []
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]
    const next = blocks[i + 1]
    if (b.type === 'ol' && next?.type === 'ul') {
      for (const item of b.items) {
        out.push({ type: 'step', text: item })
      }
      continue
    }
    out.push(b)
  }
  return out
}

const headingClass: Record<1 | 2 | 3 | 4, string> = {
  1: 'text-[15px] font-semibold tracking-tight text-[var(--color-fg)]',
  2: 'text-[14px] font-semibold text-[var(--color-fg)]',
  3: 'text-[13px] font-semibold text-[var(--color-fg)]',
  4: 'text-[13px] font-medium text-[var(--color-fg)]',
}

export function WikiRagMarkdown({
  text,
  className = '',
}: {
  text: string
  className?: string
}) {
  const blocks = parseBlocks(text || '')
  if (!blocks.length) return null

  return (
    <div className={`wikirag-md space-y-2.5 text-[13px] leading-relaxed text-[var(--color-fg)] ${className}`}>
      {blocks.map((b, idx) => {
        if (b.type === 'heading') {
          const Tag = (`h${b.level}` as 'h1' | 'h2' | 'h3' | 'h4')
          return (
            <Tag key={idx} className={`${headingClass[b.level]} ${idx > 0 ? 'mt-1' : ''}`}>
              {renderInline(b.text, `h${idx}`)}
            </Tag>
          )
        }
        if (b.type === 'hr') {
          return <hr key={idx} className="border-0 border-t border-[var(--color-border)]/80" />
        }
        if (b.type === 'ul') {
          return (
            <ul key={idx} className="list-disc space-y-1 pl-4 marker:text-[var(--color-fg-muted)]">
              {b.items.map((item, j) => (
                <li key={j}>{renderInline(item, `ul${idx}-${j}`)}</li>
              ))}
            </ul>
          )
        }
        if (b.type === 'step') {
          return (
            <p
              key={idx}
              className={`text-[13px] font-semibold text-[var(--color-fg)] ${idx > 0 ? 'mt-1' : ''}`}
            >
              {renderInline(b.text, `step${idx}`)}
            </p>
          )
        }
        if (b.type === 'ol') {
          return (
            <ol key={idx} className="list-decimal space-y-1 pl-4 marker:text-[var(--color-fg-muted)]">
              {b.items.map((item, j) => (
                <li key={j}>{renderInline(item, `ol${idx}-${j}`)}</li>
              ))}
            </ol>
          )
        }
        if (b.type === 'code') {
          return (
            <pre
              key={idx}
              className="overflow-x-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-muted)] px-3 py-2 font-mono text-[12px] leading-snug text-[var(--color-fg)]"
            >
              <code>{b.text}</code>
            </pre>
          )
        }
        return (
          <p key={idx} className="whitespace-pre-wrap">
            {renderInline(b.text, `p${idx}`)}
          </p>
        )
      })}
    </div>
  )
}
