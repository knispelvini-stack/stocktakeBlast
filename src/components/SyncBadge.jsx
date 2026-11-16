// Always-visible sync status, so nobody closes the laptop thinking data is saved
// on the server when it is only on the device.
export default function SyncBadge({ sync, onClick, onRetry }) {
  let tone, text
  if (!sync.online) {
    tone = 'offline'
    text = sync.pending ? `Offline · ${sync.pending} saved on device` : 'Offline'
  } else if (sync.syncing) {
    tone = 'syncing'
    text = sync.pending ? `Syncing ${sync.pending}…` : 'Syncing…'
  } else if (sync.pending) {
    tone = 'pending'
    text = `${sync.pending} waiting to sync`
  } else {
    tone = 'ok'
    text = 'Synced'
  }
  return (
    <div className={`sync-badge ${tone}`} title={sync.lastError || ''}>
      <button className="sync-main" onClick={onClick}>
        <span className="sync-dot" />
        {text}
        {sync.attention > 0 && <span className="sync-att"> · ⚠ {sync.attention}</span>}
      </button>
      {sync.pending > 0 && !sync.syncing && (
        <button className="sync-retry" onClick={onRetry} title="Try to sync now">
          ↻
        </button>
      )}
    </div>
  )
}
