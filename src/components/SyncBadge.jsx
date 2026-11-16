import Icon from './ui/Icon.jsx'

// Always-visible sync status, so nobody closes the laptop thinking data is saved
// on the server when it is only on the device.
export default function SyncBadge({ sync, onClick, onRetry, compact }) {
  let tone, text, short
  if (!sync.online) {
    tone = 'offline'
    text = sync.pending ? `Offline · ${sync.pending} saved on device` : 'Offline'
    short = sync.pending ? `Offline · ${sync.pending}` : 'Offline'
  } else if (sync.syncing) {
    tone = 'syncing'
    text = sync.pending ? `Syncing ${sync.pending}…` : 'Syncing…'
    short = 'Syncing'
  } else if (sync.pending) {
    tone = 'pending'
    text = `${sync.pending} waiting to sync`
    short = `${sync.pending} pending`
  } else {
    tone = 'ok'
    text = 'Synced'
    short = 'Synced'
  }
  return (
    <div className={`sync-badge ${tone}`} title={sync.lastError || text}>
      <button className="sync-main" onClick={onClick} aria-label={text}>
        <span className="sync-dot" />
        <span>{compact ? short : text}</span>
        {sync.attention > 0 && <span className="sync-att"> · ⚠ {sync.attention}</span>}
      </button>
      {sync.pending > 0 && !sync.syncing && (
        <button className="sync-retry" onClick={onRetry} title="Sync now" aria-label="Sync now">
          <Icon name="refresh" size={15} />
        </button>
      )}
    </div>
  )
}
