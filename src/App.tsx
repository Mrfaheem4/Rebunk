import { useCallback, useState } from 'react'
import MagazineCarousel from './components/MagazineCarousel'
import HudOverlay from './components/HudOverlay'

export default function App() {
  const [revealed, setRevealed] = useState(false)
  const handleReveal = useCallback(() => setRevealed(true), [])

  return (
    <main className="relative h-screen w-screen bg-black">
      <MagazineCarousel onReveal={handleReveal} />
      <HudOverlay revealed={revealed} />
    </main>
  )
}
