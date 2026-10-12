import { useParams, useSearchParams } from 'react-router-dom'
import { AssistViewer } from '../components/AssistViewer'
import type { AssistSession } from '../api'
import { useT } from '../i18n/LocaleContext'

export function AssistSessionPage() {
  const t = useT()
  const { sessionId = '' } = useParams()
  const [params] = useSearchParams()
  const hostname = (params.get('host') || '').trim()

  if (!sessionId || !hostname) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-[var(--color-bg)] px-6 text-sm text-[var(--color-fg-muted)]">
        {t('remoteConnect.assistClosed')}
      </div>
    )
  }

  const session: AssistSession = {
    id: sessionId,
    hostname,
    admin_name: '',
    status: 'offered',
  }

  return (
    <AssistViewer
      session={session}
      onClose={() => {
        window.close()
        window.setTimeout(() => {
          if (!window.closed) window.location.assign('/')
        }, 150)
      }}
    />
  )
}
