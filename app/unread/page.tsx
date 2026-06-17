import UnreadInbox from '@/components/UnreadInbox'

// Unread Messages now also lives as a section on the Dashboard (see components/
// Dashboard.tsx). This standalone route is kept for deep-links/bookmarks; it's no
// longer in the sidebar nav.
export default function UnreadPage() {
  return <UnreadInbox />
}
