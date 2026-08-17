import type { ReactNode } from 'react'

type PageHeaderProps = {
  icon: ReactNode
  title: ReactNode
  subtitle?: ReactNode
  actions?: ReactNode
}

/** Content-first page chrome: navigation already names the page, so only useful actions remain. */
export function PageHeader({ title, actions }: PageHeaderProps) {
  return (
    <>
      <h1 className="sr-only">{title}</h1>
      {actions ? <div className="flex flex-wrap items-center justify-end gap-2">{actions}</div> : null}
    </>
  )
}
