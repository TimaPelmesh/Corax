import type { Computer, RequestCategoryTreeNode, ServiceRequestTemplateRow, UserDirectoryItem } from '../../api'
import { IconPencil, IconTrash } from '../../components/icons'
import { useT } from '../../i18n/LocaleContext'
import {
  REQUEST_PRIORITIES,
  REQUEST_STATUSES,
  STATUS_PILL,
  DURATION_PRESETS_MIN,
  CategoryPicker,
  ComputerPicker,
  DirectoryAssigneesPicker,
  DirectoryRequesterPicker,
  addMinutesToLocalDatetimeValue,
  durationPresetLabel,
  isRequestPriority,
  isRequestStatus,
  requestPriorityLabel,
  requestStatusLabel,
  type RequestPriority,
  type RequestStatus,
} from './shared'

export type RequestsTemplatesPanelProps = {
  userDir: UserDirectoryItem[]
  categoryTree: RequestCategoryTreeNode[]
  pcList: Computer[]
  tplRows: ServiceRequestTemplateRow[]
  tplTotal: number
  tplLoading: boolean
  tplBusy: boolean
  tplEditingId: number | null
  tplTitle: string
  tplDescription: string
  tplRequesterName: string
  tplCategory: string
  tplStatus: RequestStatus
  tplPriority: RequestPriority
  tplOpenedAtLocal: string
  tplPlannedCloseLocal: string
  tplClosedAtLocal: string
  tplClosedSameAsPlanned: boolean
  tplAssigneeIds: number[]
  tplComputerId: string
  setTplTitle: (v: string) => void
  setTplDescription: (v: string) => void
  setTplRequesterName: (v: string) => void
  setTplCategory: (v: string) => void
  setTplStatus: (v: RequestStatus | ((prev: RequestStatus) => RequestStatus)) => void
  setTplPriority: (v: RequestPriority) => void
  setTplOpenedAtLocal: (v: string) => void
  setTplPlannedCloseLocal: (v: string) => void
  setTplClosedAtLocal: (v: string) => void
  setTplClosedSameAsPlanned: (v: boolean) => void
  setTplAssigneeIds: (v: number[]) => void
  setTplComputerId: (v: string) => void
  resetTemplateForm: () => void
  saveTemplateFromForm: () => void
  loadTemplates: () => void
  applyTemplateToForm: (tpl: ServiceRequestTemplateRow) => void
  beginEditTemplate: (tpl: ServiceRequestTemplateRow) => void
  deleteTemplate: (id: number, title: string) => void
}

export function RequestsTemplatesPanel(p: RequestsTemplatesPanelProps) {
  const t = useT()
  const {
    userDir, categoryTree, pcList, tplRows, tplTotal, tplLoading, tplBusy, tplEditingId,
    tplTitle, tplDescription, tplRequesterName, tplCategory, tplStatus, tplPriority,
    tplOpenedAtLocal, tplPlannedCloseLocal, tplClosedAtLocal, tplClosedSameAsPlanned,
    tplAssigneeIds, tplComputerId,
    setTplTitle, setTplDescription, setTplRequesterName, setTplCategory, setTplStatus,
    setTplPriority, setTplOpenedAtLocal, setTplPlannedCloseLocal, setTplClosedAtLocal,
    setTplClosedSameAsPlanned, setTplAssigneeIds, setTplComputerId,
    resetTemplateForm, saveTemplateFromForm, loadTemplates, applyTemplateToForm,
    beginEditTemplate, deleteTemplate,
  } = p
  return (
<div className="min-w-0 lg:col-span-12">

            <div className="grid gap-6 lg:grid-cols-12">
              <div className="lg:col-span-5">
                <div className="app-card flex min-h-0 flex-col rounded-2xl border-[var(--color-border)] p-4 sm:p-5 lg:min-h-[calc(100dvh-10rem)]">
                  <div className="mb-3 flex flex-wrap items-center gap-2 border-b border-[var(--color-border)] pb-2">
                    <span className="h-6 w-1 rounded-full bg-blue-600/90" aria-hidden />
                    <h2 className="font-[family-name:var(--font-display)] text-sm font-semibold tracking-tight text-[var(--color-fg)]">
                      {tplEditingId != null ? t('requests.templates.editTitle') : t('requests.templates.newTitle')}
                    </h2>
                    {tplEditingId != null ? (
                      <span className="rounded-md bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold text-amber-900 ring-1 ring-amber-200/80">
                        #{tplEditingId}
                      </span>
                    ) : null}
                  </div>

                  <label className="mb-2 block">
                    <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-[var(--color-fg-muted)]">
                      {t('requests.templates.templateTitle')}
                    </span>
                    <input
                      value={tplTitle}
                      onChange={(e) => setTplTitle(e.target.value)}
                      className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1.5 text-sm text-[var(--color-fg)] placeholder:text-[var(--color-fg-subtle)]"
                      placeholder={t('requests.templates.templateTitlePlaceholder')}
                    />
                  </label>

                  <label className="mb-3 flex min-h-[10rem] flex-1 flex-col">
                    <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-[var(--color-fg-muted)]">
                      {t('requests.templates.description')}
                    </span>
                    <textarea
                      value={tplDescription}
                      onChange={(e) => setTplDescription(e.target.value)}
                      rows={8}
                      className="min-h-[10rem] w-full flex-1 resize-y rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-2 text-sm text-[var(--color-fg)] placeholder:text-[var(--color-fg-subtle)]"
                    />
                  </label>

                  <div className="mb-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
                    <DirectoryRequesterPicker
                      users={userDir}
                      value={tplRequesterName}
                      onChange={setTplRequesterName}
                      label={t('requests.templates.requesterDefault')}
                      placeholder={t('requests.templates.requesterPlaceholder')}
                      hint={null}
                    />
                    <CategoryPicker
                      value={tplCategory}
                      onChange={setTplCategory}
                      tree={categoryTree}
                      label={t('requests.templates.categoryDefault')}
                    />
                  </div>

                  <div className="mb-2 grid grid-cols-2 gap-2">
                    <label className="block">
                      <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-[var(--color-fg-muted)]">
                        {t('requests.templates.statusDefault')}
                      </span>
                      <select
                        value={tplStatus}
                        onChange={(e) => {
                          const next = e.target.value
                          if (isRequestStatus(next)) setTplStatus(next)
                        }}
                        className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-sm font-medium text-[var(--color-fg)]"
                      >
                        {REQUEST_STATUSES.map((status) => (
                          <option key={status} value={status}>
                            {requestStatusLabel(status)}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-[var(--color-fg-muted)]">
                        {t('requests.templates.priorityDefault')}
                      </span>
                      <select
                        value={tplPriority}
                        onChange={(e) => {
                          const next = e.target.value
                          if (isRequestPriority(next)) setTplPriority(next)
                        }}
                        className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-sm font-medium text-[var(--color-fg)]"
                      >
                        {REQUEST_PRIORITIES.map((p) => (
                          <option key={p} value={p}>
                            {requestPriorityLabel(p)}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>

                  <div className="mb-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
                    <label className="block">
                      <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-[var(--color-fg-muted)]">
                        {t('requests.templates.openedAt')}
                      </span>
                      <input
                        type="datetime-local"
                        value={tplOpenedAtLocal}
                        onChange={(e) => setTplOpenedAtLocal(e.target.value)}
                        className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-sm text-[var(--color-fg)]"
                      />
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-[var(--color-fg-muted)]">
                        {t('requests.templates.plannedCloseAt')}
                      </span>
                      <input
                        type="datetime-local"
                        value={tplPlannedCloseLocal}
                        onChange={(e) => setTplPlannedCloseLocal(e.target.value)}
                        className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-sm text-[var(--color-fg)]"
                      />
                      <div className="mt-1 flex flex-wrap gap-1">
                        {DURATION_PRESETS_MIN.map((p) => (
                          <button
                            key={`tpl-${p.minutes}`}
                            type="button"
                            className="rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-1.5 py-0.5 text-[10px] font-semibold text-[var(--color-fg)] hover:bg-[var(--color-surface-muted)]"
                            title={t('requests.durations.fromTemplateOpenedTitle', {
                              label: durationPresetLabel(p.minutes),
                              hotkey: p.hotkey,
                            })}
                            onClick={() => setTplPlannedCloseLocal(addMinutesToLocalDatetimeValue(tplOpenedAtLocal, p.minutes))}
                          >
                            +{durationPresetLabel(p.minutes)}
                          </button>
                        ))}
                      </div>
                    </label>
                  </div>

                  <label className="mb-2 block">
                    <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-[var(--color-fg-muted)]">
                      {t('requests.templates.closedAt')}
                    </span>
                    <label className="mb-1 flex cursor-pointer items-center gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-2 py-1">
                      <input
                        type="checkbox"
                        className="h-3.5 w-3.5 shrink-0 rounded border-slate-300 text-blue-600 focus:ring-blue-500/30"
                        checked={tplClosedSameAsPlanned}
                        onChange={(e) => {
                          const on = e.target.checked
                          setTplClosedSameAsPlanned(on)
                          if (on) {
                            setTplClosedAtLocal(tplPlannedCloseLocal)
                            if (tplPlannedCloseLocal.trim()) {
                              setTplStatus((prev) => (prev === 'cancelled' ? 'cancelled' : 'done'))
                            }
                          }
                        }}
                      />
                      <span className="text-[11px] leading-snug text-[var(--color-fg)]">
                        {t('requests.templates.closedSameAsPlanned')}
                      </span>
                    </label>
                    {!tplClosedSameAsPlanned ? (
                      <input
                        type="datetime-local"
                        value={tplClosedAtLocal}
                        onChange={(e) => {
                          const v = e.target.value
                          setTplClosedAtLocal(v)
                          if (v.trim()) setTplStatus((prev) => (prev === 'cancelled' ? 'cancelled' : 'done'))
                        }}
                        className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-sm text-[var(--color-fg)]"
                      />
                    ) : null}
                  </label>

                  <div className="mb-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
                    <DirectoryAssigneesPicker
                      users={userDir}
                      selectedIds={tplAssigneeIds}
                      onChange={setTplAssigneeIds}
                      className="min-w-0"
                      inputClassName="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-sm text-[var(--color-fg)] placeholder:text-[var(--color-fg-subtle)]"
                      hint={null}
                    />
                    <ComputerPicker
                      computers={pcList}
                      valueId={tplComputerId}
                      onChange={setTplComputerId}
                      className="relative min-w-0"
                      labelClassName="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-[var(--color-fg-muted)]"
                      inputClassName="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-sm text-[var(--color-fg)] placeholder:text-[var(--color-fg-subtle)]"
                    />
                  </div>

                  <div className="mt-auto flex flex-col gap-2 pt-4 sm:flex-row">
                    {tplEditingId != null ? (
                      <button
                        type="button"
                        disabled={tplBusy}
                        onClick={() => resetTemplateForm()}
                        className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] py-2 text-sm font-semibold text-[var(--color-fg)] hover:bg-[var(--color-surface-muted)] disabled:opacity-50 sm:w-auto sm:min-w-[7rem]"
                      >
                        {t('requests.templates.cancel')}
                      </button>
                    ) : null}
                    <button
                      type="button"
                      disabled={tplBusy || !tplTitle.trim()}
                      onClick={() => void saveTemplateFromForm()}
                      className="app-btn app-btn-primary w-full flex-1 !min-h-[40px] !text-sm"
                    >
                      {tplBusy
                        ? t('requests.templates.saving')
                        : tplEditingId != null
                          ? t('requests.templates.saveChanges')
                          : t('requests.templates.saveTemplate')}
                    </button>
                  </div>
                </div>
              </div>

              <div className="lg:col-span-7">
                <div className="mb-3 flex items-end justify-between gap-3">
                  <h2 className="text-sm font-semibold text-[var(--color-fg)]">
                    {t('requests.templates.title')}
                    {!tplLoading ? <span className="ml-2 font-normal text-[var(--color-fg-muted)]">· {tplTotal}</span> : null}
                  </h2>
                  <button
                    type="button"
                    disabled={tplLoading}
                    onClick={() => void loadTemplates()}
                    className="app-btn app-btn-secondary !min-h-0 !px-3 !py-2 !text-xs disabled:opacity-50"
                  >
                    {t('requests.templates.refresh')}
                  </button>
                </div>

                <div className="space-y-2">
                  {tplLoading ? (
                    <p className="app-empty-state">{t('requests.templates.loading')}</p>
                  ) : tplRows.length === 0 ? (
                    <p className="app-empty-state">{t('requests.templates.empty')}</p>
                  ) : (
                    tplRows.map((tpl) => (
                      <article
                        key={tpl.id}
                        className="app-card px-3 py-2"
                      >
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                          <h3 className="min-w-0 flex-1 text-sm font-semibold text-[var(--color-fg)]">{tpl.title}</h3>
                          <span
                            className={`inline-flex rounded-md px-1.5 py-0.5 text-[10px] font-semibold ${STATUS_PILL[tpl.status] ?? 'bg-[var(--color-surface-muted)] text-[var(--color-fg)] ring-1 ring-slate-200'}`}
                          >
                            {requestStatusLabel(tpl.status)}
                          </span>
                          <button
                            type="button"
                            onClick={() => applyTemplateToForm(tpl)}
                            className="app-btn app-btn-primary !min-h-0 !px-2.5 !py-1 !text-[11px]"
                          >
                            {t('requests.templates.apply')}
                          </button>
                          <button
                            type="button"
                            onClick={() => beginEditTemplate(tpl)}
                            className="app-btn app-btn-secondary !min-h-0 !px-1.5 !py-1"
                            title={t('requests.templates.edit')}
                            aria-label={t('requests.templates.edit')}
                          >
                            <IconPencil className="h-3.5 w-3.5" />
                          </button>
                          <button
                            type="button"
                            disabled={tplBusy}
                            onClick={() => void deleteTemplate(tpl.id, tpl.title)}
                            className="app-btn app-btn-secondary !min-h-0 !px-1.5 !py-1 disabled:opacity-50"
                            title={t('requests.templates.delete')}
                            aria-label={t('requests.templates.delete')}
                          >
                            <IconTrash className="h-3.5 w-3.5" />
                          </button>
                        </div>
                        {tpl.description ? (
                          <p className="mt-1 line-clamp-1 text-xs text-[var(--color-fg-muted)]">{tpl.description}</p>
                        ) : null}
                        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-[var(--color-fg-subtle)]">
                          {tpl.requester_name ? <span>{t('requests.templates.requester', { name: tpl.requester_name })}</span> : null}
                          {tpl.category ? <span>{t('requests.templates.category', { name: tpl.category })}</span> : null}
                          {tpl.assignee_usernames && tpl.assignee_usernames.length > 0 ? (
                            <span className="font-medium text-[var(--color-fg-muted)]" title={tpl.assignee_usernames.join(', ')}>
                              {t('requests.templates.assignees', { names: tpl.assignee_usernames.join(', ') })}
                            </span>
                          ) : null}
                          {tpl.computer_id ? <span>{t('requests.templates.pc', { id: tpl.computer_id })}</span> : null}
                          <span>{requestPriorityLabel(tpl.priority)}</span>
                        </div>
                      </article>
                    ))
                  )}
                </div>
              </div>
            </div>
          </div>
  )
}
