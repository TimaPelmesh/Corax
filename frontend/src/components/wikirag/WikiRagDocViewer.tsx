import { useCallback, useEffect, useState } from 'react'

import { api, type WikiRagDocContent, type WikiRagDocumentRow } from '../../api'
import { useT } from '../../i18n/LocaleContext'
import { useToast } from '../../ToastContext'



export function WikiRagDocViewer({

  doc,

  canManage,

  onSaved,

  embedded = false,

}: {

  doc: WikiRagDocumentRow | null

  canManage: boolean

  onSaved?: () => void

  embedded?: boolean

}) {
  const t = useT()
  const toast = useToast()

  const [content, setContent] = useState<WikiRagDocContent | null>(null)

  const [draft, setDraft] = useState('')

  const [loading, setLoading] = useState(false)

  const [saving, setSaving] = useState(false)



  const load = useCallback(async () => {

    if (!doc) {

      setContent(null)

      setDraft('')

      return

    }

    setLoading(true)

    try {

      const c = await api.wikiRagDocumentContent(doc.id)

      setContent(c)

      setDraft(c.content ?? '')

    } catch (e) {

      setContent(null)

      toast.error(e instanceof Error ? e.message : t('wikirag.viewer.openFailed'))

    } finally {

      setLoading(false)

    }

  }, [doc, t, toast])



  useEffect(() => {

    void load()

  }, [load])



  async function save() {

    if (!doc || !content?.editable) return

    setSaving(true)

    try {

      const c = await api.saveWikiRagDocumentContent(doc.id, draft)

      setContent(c)

      setDraft(c.content ?? '')

      onSaved?.()

    } catch (e) {

      toast.error(e instanceof Error ? e.message : t('wikirag.viewer.saveFailed'))

    } finally {

      setSaving(false)

    }

  }



  if (!doc) {

    return (

      <div className="flex min-h-[14rem] items-center justify-center rounded-xl border border-dashed border-neutral-200 bg-neutral-50/50 p-6 text-center text-sm text-slate-500">

        {t('wikirag.viewer.chooseDocument')}

      </div>

    )

  }



  const previewSrc =

    content?.kind === 'image'

      ? content.preview_url?.startsWith('data:')

        ? content.preview_url

        : api.wikiRagFileUrl(doc.id)

      : null



  return (

    <div className="flex min-h-[12rem] flex-col">

      {!embedded ? (

        <div className="mb-3 border-b border-neutral-100 pb-3">

          <h3 className="truncate text-sm font-semibold text-neutral-950">{doc.original_filename}</h3>

          {content?.hint ? <p className="mt-0.5 text-xs text-slate-500">{content.hint}</p> : null}

        </div>

      ) : content?.hint ? (

        <p className="mb-2 text-xs text-slate-500">{content.hint}</p>

      ) : null}



      <div className="mb-3 flex flex-wrap gap-2">

        <a

          href={api.wikiRagFileUrl(doc.id)}

          download={doc.original_filename}

          className="rounded-lg border border-neutral-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-neutral-800 shadow-sm hover:bg-neutral-50"

        >

          {t('wikirag.viewer.download')}

        </a>

        {content?.editable && canManage ? (

          <button

            type="button"

            disabled={saving || draft === (content.content ?? '')}

            onClick={() => void save()}

            className="app-btn app-btn-primary !min-h-[32px] !px-2.5 !py-1.5 !text-xs"

          >

            {saving ? t('wikirag.viewer.saving') : t('wikirag.viewer.saveFile')}

          </button>

        ) : null}

      </div>






      <div className="min-h-0 flex-1 overflow-auto">

        {loading ? (

          <p className="text-sm text-slate-500">{t('wikirag.viewer.loadingContent')}</p>

        ) : content?.kind === 'image' && previewSrc ? (

          <img

            src={previewSrc}

            alt={doc.original_filename}

            className="max-h-[min(65vh,32rem)] rounded-lg border border-neutral-200 object-contain"

          />

        ) : content?.editable && canManage ? (

          <textarea

            value={draft}

            onChange={(e) => setDraft(e.target.value)}

            className="h-[min(65vh,32rem)] w-full resize-y rounded-xl border border-neutral-200 bg-white px-3 py-2 font-mono text-xs leading-relaxed text-neutral-900 shadow-sm outline-none focus:border-blue-300 focus:ring-2 focus:ring-blue-500/20"

            spellCheck={false}

          />

        ) : (

          <pre className="whitespace-pre-wrap break-words rounded-xl border border-neutral-200 bg-neutral-50/80 p-3 font-mono text-xs leading-relaxed text-neutral-800">

            {content?.content?.trim() || '—'}

          </pre>

        )}

        {content?.truncated ? (

          <p className="mt-2 text-xs text-amber-700">{t('wikirag.viewer.truncated')}</p>

        ) : null}

      </div>

    </div>

  )

}


