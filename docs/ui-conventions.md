# UI conventions (panel)

Patterns taken from shared components (`ConfirmDialog`, `AppModal`, `AppFold`, `StatusPill`, `PageHeader`) and public a11y practice. Prefer these over inventing page-local chrome.

## Page chrome

- **`PageHeader`**: title is `sr-only` (`h1`). Navigation already names the page; only useful **actions** belong in the header row.
- Keep the first useful control reachable without hunting through decorative chrome.

## Folds / disclosure

- Use **`AppFold`** for collapsible sections: `aria-expanded` on the trigger, `aria-controls` + `role="region"` on the body, body uses the `hidden` attribute when closed.
- Sidebar groups and menu buttons follow the same rule: the control that toggles visibility must expose `aria-expanded`.
- Do not rely on native `<details>` unless the page already does; `AppFold` is the shared replacement.

## Modals and confirms

- **`AppModal`**: portal to `document.body`, `role="dialog"` + `aria-modal="true"` + `aria-labelledby`, backdrop click closes, **Escape** closes, initial focus on the close control, previous focus restored on unmount.
- **`ConfirmDialog` / `useConfirmDialog`**: same Escape / focus / restore behavior; focus lands on the **confirm** button. Body text is wired with `aria-describedby` when present.
- Destructive actions use `tone="danger"` (`app-btn-danger`). Cancel uses the shared secondary button and `common.cancel`.
- Trap Tab inside the confirm panel (first ↔ last enabled button). Prefer `useConfirmDialog().ask(...)` over ad-hoc `window.confirm`.

## Status indicators

- Prefer **`StatusPill`** (`role="status"`, tone classes `app-status-pill--{success|warning|error|info|neutral}`) over one-off colored badges.
- Transient messages (caps lock, progress labels, live regions) use `role="status"` or `aria-live="polite"` so screen readers hear updates without stealing focus.
- Decorative icons/scenes stay `aria-hidden`; interactive icon-only controls need an `aria-label` (see login password toggle / modal close).

## Forms and feedback

- Invalid fields: `aria-invalid` plus `aria-describedby` pointing at the helper/error id when shown.
- Toggle groups (language, filters): `role="group"` with an accessible name; selected option uses `aria-pressed` where that matches the control pattern.
