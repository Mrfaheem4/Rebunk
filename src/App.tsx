import { useCallback, useRef, useState } from 'react'
import MagazineCarousel, { type CarouselHandle } from './components/MagazineCarousel'
import HudOverlay from './components/HudOverlay'

export default function App() {
  const carouselRef = useRef<CarouselHandle>(null)
  const counterRef = useRef<HTMLSpanElement>(null)
  const [replayKey, setReplayKey] = useState(0)

  const handleReplay = useCallback(() => {
    carouselRef.current?.replay()
    setReplayKey((k) => k + 1) // re-runs the HUD scramble only (not per-frame)
  }, [])

  return (
    <main className="relative h-screen w-screen bg-black">
      <MagazineCarousel ref={carouselRef} counterRef={counterRef} />
      <HudOverlay replayKey={replayKey} onReplay={handleReplay} counterRef={counterRef} />
    </main>
  )
}
