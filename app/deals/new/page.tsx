import { redirect } from 'next/navigation'

export default function NewDealPage() {
  // Manual deal creation was removed — deals come from GHL sync + the Arive import.
  redirect('/deals')
}
