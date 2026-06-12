import Dashboard from '@/components/Dashboard'
import DailyVerse from '@/components/DailyVerse'

export default function Home() {
  return (
    <>
      <div className="px-6 pt-6">
        <DailyVerse />
      </div>
      <Dashboard />
    </>
  )
}
