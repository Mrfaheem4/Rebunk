import { useEffect, type RefObject } from 'react'

const GLYPHS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789#/_-+*<>'

/**
 * Character scramble / typewriter reveal.
 * Every descendant with `data-scramble="FINAL TEXT"` is animated in parallel.
 * Writes straight to `textContent` inside rAF — no React state per frame.
 */
export function useScramble(
  root: RefObject<HTMLElement | null>,
  trigger: number,
  duration = 1000,
) {
  useEffect(() => {
    const el = root.current
    if (!el) return
    const nodes = Array.from(el.querySelectorAll<HTMLElement>('[data-scramble]'))
    const finals = nodes.map((n) => n.dataset.scramble ?? '')
    const start = performance.now()
    let raf = 0

    const tick = (now: number) => {
      const p = Math.min((now - start) / duration, 1)
      nodes.forEach((node, k) => {
        const text = finals[k]
        const len = Math.max(text.length, 1)
        let out = ''
        for (let c = 0; c < text.length; c++) {
          const ch = text[c]
          const typeAt = (c / len) * 0.45 // typewriter: char appears
          const lockAt = 0.3 + (c / len) * 0.7 // scramble: char locks in
          if (p < typeAt) break
          if (ch === ' ' || p >= lockAt) out += ch
          else out += GLYPHS[(Math.random() * GLYPHS.length) | 0]
        }
        node.textContent = out
      })
      if (p < 1) raf = requestAnimationFrame(tick)
    }

    raf = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(raf)
      nodes.forEach((n, k) => (n.textContent = finals[k]))
    }
  }, [root, trigger, duration])
}
