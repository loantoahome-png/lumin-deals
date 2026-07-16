import { redirect } from 'next/navigation'

// Notes now live on the Bulletin tab of the combined Bulletin/Tasks page (/tasks).
export default function NotesPage() {
  redirect('/tasks?tab=bulletin')
}
