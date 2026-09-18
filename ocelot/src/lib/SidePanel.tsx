import type { ReactNode } from 'react';

/**
 * A slide-in drawer confined to this plugin's own iframe — sandboxed views
 * have no host-level panel API (no `promenade.focus()` or similar), so this
 * is plain absolutely-positioned DOM inside the plugin's own `#root`, same
 * idiom `ocpn-flow-view` uses for its own Legend popover.
 */
export function SidePanel({ open, title, onClose, children }: {
  open: boolean;
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <div className={`oc-sidepanel${open ? '' : ' closed'}`} aria-hidden={!open}>
      <div className="oc-sidepanel-head">
        <strong>{title}</strong>
        <button className="oc-close-btn" onClick={onClose} aria-label="Close">×</button>
      </div>
      <div className="oc-sidepanel-body">{children}</div>
    </div>
  );
}
