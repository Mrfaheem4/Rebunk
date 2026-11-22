import { useRef } from 'react'
import { useScramble } from '../hooks/useScramble'

type Props = {
  replayKey: number
  onReplay: () => void
}

const HUD_SCRAMBLE_MS = 1000
/** File lives in /public/logo — the name has spaces/parens, so it's URL-encoded. */
const LOGO_URL = encodeURI('/logo/Rebunk _ Logo (1).svg')

export default function HudOverlay({ replayKey, onReplay }: Props) {
  const rootRef = useRef<HTMLDivElement>(null)
  useScramble(rootRef, replayKey, HUD_SCRAMBLE_MS)

  return (
    <div
      ref={rootRef}
      className="pointer-events-none fixed inset-0 z-10 h-screen w-screen select-none font-mono text-[0.75rem] uppercase leading-[1.35] tracking-[0.08em] text-crimson sm:text-[0.8125rem]"
    >
      {/* Top-left: Rebunk logo (white wordmark) */}
      <div className="absolute left-[1.25rem] top-[1.125rem] sm:left-[1.75rem] sm:top-[1.5rem]">
        <img src={LOGO_URL} alt="Rebunk" className="block h-[2.75rem] w-auto sm:h-[3.75rem]" draggable={false} />
      </div>

      {/* Top-right: replay */}
      <button
        type="button"
        onClick={onReplay}
        className="pointer-events-auto absolute right-[1.25rem] top-[0.875rem] cursor-pointer border border-crimson/60 px-[0.625rem] py-[0.25rem] uppercase tracking-[0.12em] text-crimson transition-colors hover:bg-crimson hover:text-black sm:right-[1.75rem] sm:top-[1.25rem]"
      >
        <span data-scramble="Replay" />
      </button>

      {/* Bottom-left */}
      <div className="absolute bottom-[1.125rem] left-[1.25rem] flex flex-col sm:bottom-[1.5rem] sm:left-[1.75rem]">
        <span data-scramble="TYPEONE MAGAZINE" className="whitespace-pre" />
        <span data-scramble="September 2025" className="whitespace-pre" />
      </div>

      {/* Bottom-right */}
      <div className="absolute bottom-[1.125rem] right-[1.25rem] text-right sm:bottom-[1.5rem] sm:right-[1.75rem]">
        <span data-scramble="ISSUE#10" />
      </div>
    </div>
  )
}
