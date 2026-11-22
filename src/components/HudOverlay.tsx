import type { CSSProperties, ReactNode } from 'react'

/** File lives in /public/logo — the name has spaces/parens, so it's URL-encoded. */
const LOGO_URL = encodeURI('/logo/Rebunk _ Logo (1).svg')

/** Reveal timing (ms) — plays when the carousel starts forming after the explosion. */
const REVEAL = {
  duration: 1100,
  ease: 'cubic-bezier(0.16, 1, 0.3, 1)', // expo-out: fast start, long soft settle
  logoDelay: 0,
  lineDelay: 180, // first title line
  lineStagger: 110, // each following line
}

type Props = {
  /** Flips to true as the carousel appears; triggers the entrance animation. */
  revealed: boolean
}

/** One title line that slides up from behind a mask. */
function MaskLine({ children, show, delay }: { children: ReactNode; show: boolean; delay: number }) {
  const style: CSSProperties = {
    transform: show ? 'translateY(0)' : 'translateY(110%)',
    transition: `transform ${REVEAL.duration}ms ${REVEAL.ease} ${delay}ms`,
  }
  return (
    <span className="block overflow-hidden pb-[0.08em]">
      <span className="block will-change-transform" style={style}>
        {children}
      </span>
    </span>
  )
}

export default function HudOverlay({ revealed }: Props) {
  const logoStyle: CSSProperties = {
    opacity: revealed ? 1 : 0,
    transform: revealed ? 'translateY(0)' : 'translateY(-0.75rem)',
    filter: revealed ? 'blur(0px)' : 'blur(8px)',
    transition: ['opacity', 'transform', 'filter']
      .map((p) => `${p} ${REVEAL.duration}ms ${REVEAL.ease} ${REVEAL.logoDelay}ms`)
      .join(', '),
  }

  return (
    <div className="pointer-events-none fixed inset-0 z-10 h-screen w-screen select-none font-sans tracking-[-0.04em] text-white">
      {/* Top-left: Rebunk logo */}
      <div className="absolute left-[1.25rem] top-[1.125rem] sm:left-[1.75rem] sm:top-[1.5rem]">
        <img
          src={LOGO_URL}
          alt="Rebunk"
          className="block h-[2.125rem] w-auto will-change-transform sm:h-[2.75rem]"
          style={logoStyle}
          draggable={false}
        />
      </div>

      {/* Bottom-left: archive title */}
      <div className="absolute bottom-[1.75rem] left-[1.25rem] sm:bottom-[3rem] sm:left-[2.5rem]">
        <h1 className="m-0 text-[1.25rem] font-bold leading-[1.1] sm:text-[1.625rem]">
          <MaskLine show={revealed} delay={REVEAL.lineDelay}>
            Rebel Punk
          </MaskLine>
          <MaskLine show={revealed} delay={REVEAL.lineDelay + REVEAL.lineStagger}>
            Poster Archive
          </MaskLine>
        </h1>
      </div>
    </div>
  )
}
