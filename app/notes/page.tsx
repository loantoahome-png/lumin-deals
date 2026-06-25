import { redirect } from 'next/navigation'

// Notes now live on the combined Bulletin/Tasks page (/tasks).
export default function NotesPage() {
  redirect('/tasks')
}
