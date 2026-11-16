import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import Icon from './Icon.jsx'

// ───────── layout primitives ─────────

export function PageHeader({ title, description, actions, back }) {
  return (
    <header className="page-header">
      <div className="page-header-text">
        {back && (
          <button className="breadcrumb" onClick={back.onClick}>
            <Icon name="chevronLeft" size={16} /> {back.label}
          </button>
        )}
        <h1>{title}</h1>
        {description && <p className="page-desc">{description}</p>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </header>
  )
}

export function Section({ title, description, actions, children, flush }) {
  return (
    <section className={`panel ${flush ? 'flush' : ''}`}>
      {(title || actions) && (
        <div className="panel-head">
          <div>
            {title && <h2>{title}</h2>}
            {description && <p className="panel-desc">{description}</p>}
          </div>
          {actions && <div className="panel-actions">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  )
}

export function EmptyState({ icon = 'box', title, children, action }) {
  return (
    <div className="empty">
      <div className="empty-icon">
        <Icon name={icon} size={22} />
      </div>
      <div className="empty-title">{title}</div>
      {children && <div className="empty-body">{children}</div>}
      {action}
    </div>
  )
}

export function Stat({ label, value, hint, tone = '', icon }) {
  return (
    <div className={`stat ${tone}`}>
      <div className="stat-label">
        {icon && <Icon name={icon} size={15} />}
        {label}
      </div>
      <div className="stat-value">{value}</div>
      {hint && <div className="stat-hint">{hint}</div>}
    </div>
  )
}

export function Badge({ tone = 'neutral', children }) {
  return <span className={`badge-pill ${tone}`}>{children}</span>
}

const STATUS = {
  in_stock: ['ok', 'In stock'],
  out: ['warn', 'Out'],
  lost: ['error', 'Lost'],
  retired: ['neutral', 'Retired'],
  open: ['ok', 'Open'],
  closed: ['neutral', 'Closed'],
}
export function StatusBadge({ status }) {
  const [tone, label] = STATUS[status] ?? ['neutral', status]
  return <Badge tone={tone}>{label}</Badge>
}

// ───────── modal ─────────

export function Modal({ title, description, onClose, children, footer, size = 'md' }) {
  const ref = useRef(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  // Mount-only: focus the first field once and restore focus on close. (A
  // dependency on onClose would re-run this on every parent render and steal
  // focus mid-typing.)
  useEffect(() => {
    const prev = document.activeElement
    const first = ref.current?.querySelector('input, select, textarea, button:not(.modal-x)')
    first?.focus()
    const onKey = e => e.key === 'Escape' && closeRef.current?.()
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      prev?.focus?.()
    }
  }, [])
  return (
    <div className="modal-backdrop" onMouseDown={e => e.target === e.currentTarget && onClose?.()}>
      <div className={`modal ${size}`} role="dialog" aria-modal="true" aria-labelledby="modal-title" ref={ref}>
        <div className="modal-head">
          <div>
            <h2 id="modal-title">{title}</h2>
            {description && <p className="panel-desc">{description}</p>}
          </div>
          {onClose && (
            <button className="icon-btn modal-x" onClick={onClose} aria-label="Close">
              <Icon name="x" />
            </button>
          )}
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  )
}

// ───────── toasts + confirm (replace window.alert / window.confirm) ─────────

const UICtx = createContext(null)
let toastSeq = 0

export function UIProvider({ children }) {
  const [toasts, setToasts] = useState([])
  const [dialog, setDialog] = useState(null)

  const toast = useCallback((message, tone = 'neutral') => {
    const id = ++toastSeq
    setToasts(t => [...t, { id, message, tone }].slice(-3)) // newest 3; older ones would cover the screen
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), tone === 'error' ? 7000 : 4000)
  }, [])

  const confirm = useCallback(
    opts =>
      new Promise(resolve => {
        setDialog({ ...opts, resolve })
      }),
    [],
  )

  function close(result) {
    dialog?.resolve(result)
    setDialog(null)
  }

  return (
    <UICtx.Provider value={{ toast, confirm }}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map(t => (
          <div key={t.id} className={`toast ${t.tone}`}>
            <Icon name={t.tone === 'error' ? 'alert' : t.tone === 'ok' ? 'check' : 'activity'} size={16} />
            <span>{t.message}</span>
          </div>
        ))}
      </div>
      {dialog && (
        <Modal
          title={dialog.title}
          onClose={() => close(false)}
          size="sm"
          footer={
            <>
              <button className="secondary" onClick={() => close(false)}>
                {dialog.cancelLabel ?? 'Cancel'}
              </button>
              <button className={dialog.danger ? 'danger' : 'primary'} onClick={() => close(true)}>
                {dialog.confirmLabel ?? 'Confirm'}
              </button>
            </>
          }
        >
          <div className="confirm-body">{dialog.body}</div>
        </Modal>
      )}
    </UICtx.Provider>
  )
}

export function useUI() {
  return useContext(UICtx)
}

// ───────── formatting ─────────

export function timeAgo(iso) {
  if (!iso) return '—'
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`
  const d = Math.floor(s / 86400)
  return d === 1 ? 'yesterday' : `${d} days ago`
}

export function formatDateTime(iso) {
  if (!iso) return '—'
  return new Date(iso).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
}
