import { forwardRef, useEffect, useImperativeHandle, useRef, type RefObject } from 'react'
import * as THREE from 'three'
import gsap from 'gsap'
import { POSTER_URLS, createPosterMaterials, loadPosterTextures } from '../lib/cardTextures'

/* ══════════════════════════════════════════════════════════════════════════
 * TUNING — every timing / easing / physics constant lives here.
 * (Movement identical to the first version; cards are now 0-thickness.)
 * ══════════════════════════════════════════════════════════════════════════ */

/** How many times the 4 posters repeat around the ring (3 → 12 cards). */
const POSTER_REPEATS = 3
const CARD_COUNT = POSTER_URLS.length * POSTER_REPEATS
const CARD_SIZE = { w: 2.2, h: 3.1 } // flat plane, zero thickness
const STEP = (Math.PI * 2) / CARD_COUNT // angle between neighbouring cards

const CAMERA_FOV = 62 // front card ≈ 75% of viewport height at camZ 8.6
/** Fog distances relative to the camera — dims the back arc of the cylinder for depth. */
const FOG = { nearOffset: -1.5, farOffset: 11 }

/** t = 0.0s */
const INITIAL_STATE = {
  camZ: 14,
  radius: 0.5,
  tiltX: 1.25, // ~72° pitched forward — disc viewed nearly edge-on
  tiltZ: 0.42, // ~24° diagonal roll
  spinSpeed: 2.8, // rad/s
  epicycleAmount: 0,
  orbitSpeed: 6.5, // rad/s
  cardScale: 0.22,
}

/** Phase 1A — radial burst (0.0s – 0.9s) */
const PHASE_1A = { at: 0, duration: 0.9, ease: 'power2.out', radius: 3.6, cardScale: 0.65, tiltX: 0.45 }

/** Phase 1A — epicyclic micro-orbits fade in (0.1s – 0.85s) */
const EPICYCLE_IN = { at: 0.1, duration: 0.75, ease: 'sine.inOut', epicycleAmount: 1 }

/** Phase 1B — level out & lock into the carousel (0.85s – 2.15s) */
const PHASE_1B = {
  at: 0.85,
  duration: 1.3,
  ease: 'expo.out',
  radius: 5.2,
  cardScale: 1,
  tiltX: 0,
  tiltZ: 0,
  epicycleAmount: 0,
  spinSpeed: 0.25,
  camZ: 8.6,
}

/** Per-card epicycle randomisation (deterministic). */
const ORBIT_RADIUS_RANGE: [number, number] = [0.75, 1.25]
const SCATTER_RANGE: [number, number] = [-0.4, 0.4]

/** Post-intro interaction */
const ROTATION_DAMPING = 0.08 // lerp factor per 60fps frame
const HANDOFF_MAX_DURATION = 2.6 // s — glide from idle spin into the first snapped card
const DRAG_CARDS_PER_SCREEN = 3.2 // dragging a full viewport width moves this many cards
const DRAG_INERTIA_MS = 180 // release velocity is projected this far ahead before snapping
const MAX_FLING_CARDS = 4
const WHEEL_RAD_PER_PX = STEP / 220
const WHEEL_SNAP_DELAY_MS = 150
const AUTO_ADVANCE_MS = 4200 // idle drift: step to the next card after this long untouched
const PARALLAX_MAX = 0.06 // rad, linked to cursor Y
const PARALLAX_DAMPING = 0.06
const REST_TILT_X = 0.05 // slight downward look so the back arc peeks through the gaps
const BLEND_DAMPING = 0.05 // fades rest-tilt + parallax in after the intro

/* ══════════════════════════════════════════════════════════════════════════ */

export type CarouselHandle = { replay: () => void }

type Props = {
  /** HUD node that receives "03 / 12" text directly (no React re-render). */
  counterRef?: RefObject<HTMLSpanElement | null>
}

type Card = {
  anchor: THREE.Group
  mesh: THREE.Mesh
  orbitPhase: number
  orbitRadius: number
  scatterRadiusOffset: number
}

type Phase = 'loading' | 'intro' | 'handoff' | 'interactive'

/** Deterministic pseudo-random in [0, 1). */
const seeded = (i: number, salt = 0) => {
  const x = Math.sin(i * 127.1 + salt * 311.7) * 43758.5453
  return x - Math.floor(x)
}
const lerpRange = ([a, b]: [number, number], t: number) => a + (b - a) * t
/** Frame-rate independent version of `x += (target - x) * f`. */
const damp = (f: number, dt: number) => 1 - Math.pow(1 - f, dt * 60)
const snap = (rot: number) => Math.round(rot / STEP) * STEP
const pad2 = (n: number) => String(n).padStart(2, '0')

const MagazineCarousel = forwardRef<CarouselHandle, Props>(function MagazineCarousel({ counterRef }, ref) {
  const mountRef = useRef<HTMLDivElement>(null)
  const replayRef = useRef<() => void>(() => {})

  useImperativeHandle(ref, () => ({ replay: () => replayRef.current() }), [])

  useEffect(() => {
    const mount = mountRef.current!
    let disposed = false

    /* ── renderer / scene / camera ─────────────────────────────────────── */
    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.setSize(mount.clientWidth, mount.clientHeight)
    renderer.setClearColor(0x000000, 1)
    renderer.outputColorSpace = THREE.SRGBColorSpace
    renderer.domElement.style.display = 'block'
    renderer.domElement.style.touchAction = 'none'
    mount.appendChild(renderer.domElement)
    const anisotropy = renderer.capabilities.getMaxAnisotropy()

    const scene = new THREE.Scene()
    const fog = new THREE.Fog(0x000000, 1, 2)
    scene.fog = fog

    const camera = new THREE.PerspectiveCamera(CAMERA_FOV, mount.clientWidth / mount.clientHeight, 0.1, 100)
    camera.position.set(0, 0, INITIAL_STATE.camZ)

    /* ── tier 1: carouselPivot ─────────────────────────────────────────── */
    const carouselPivot = new THREE.Group()
    // Y (spin) is applied first, then Z/X tilt — the ring spins in its own
    // plane while the tilt stays fixed in world space (no wobble / gimbal).
    carouselPivot.rotation.order = 'XZY'
    scene.add(carouselPivot)

    const geometry = new THREE.PlaneGeometry(CARD_SIZE.w, CARD_SIZE.h)
    const cards: Card[] = []
    let posters: (THREE.Texture | null)[] = []
    let materials: THREE.Material[] = []

    /* ── animation state (GSAP mutates this; the loop reads it) ───────── */
    const anim = { ...INITIAL_STATE }
    const motion = {
      phase: 'loading' as Phase,
      rotY: 0, // carouselPivot.rotation.y
      target: 0, // interactive target rotation
      orbitTime: 0,
      parallax: 0,
      parallaxTarget: 0,
      blend: 0, // 0 during intro → 1 interactive (rest tilt + parallax weight)
      lastInteraction: 0,
      activeIndex: -1,
    }
    let introTl: gsap.core.Timeline | null = null
    let handoffTween: gsap.core.Tween | null = null

    // Tuning aid: `?slow=10` plays the intro 10× slower.
    const slow = Number(new URLSearchParams(window.location.search).get('slow'))
    const introTimeScale = slow > 0 ? 1 / slow : 1

    // Portrait screens: pull the camera back so the front card fits the width.
    let viewFit = 1
    const resize = () => {
      const w = mount.clientWidth
      const h = mount.clientHeight
      renderer.setSize(w, h)
      camera.aspect = w / h
      camera.updateProjectionMatrix()
      viewFit = Math.max(1, 0.95 / camera.aspect)
    }
    resize()

    /* ── intro timeline ────────────────────────────────────────────────── */
    const startHandoff = () => {
      // Glide from the residual idle spin into the next card slot ahead,
      // matching the initial velocity of `sine.out` to the current spin speed
      // so there is no jump in position *or* speed.
      let target = Math.ceil(motion.rotY / STEP) * STEP
      if (target - motion.rotY < STEP * 0.25) target += STEP
      const gap = target - motion.rotY
      const duration = Math.min(((Math.PI / 2) * gap) / Math.max(anim.spinSpeed, 0.05), HANDOFF_MAX_DURATION)
      motion.phase = 'handoff'
      motion.target = target
      handoffTween = gsap.to(motion, {
        rotY: target,
        duration,
        ease: 'sine.out',
        onComplete: () => {
          motion.phase = 'interactive'
          motion.lastInteraction = performance.now()
        },
      })
    }

    const takeControl = () => {
      if (motion.phase === 'handoff') {
        handoffTween?.kill()
        motion.target = motion.rotY
        motion.phase = 'interactive'
      }
      motion.lastInteraction = performance.now()
    }

    const playIntro = () => {
      introTl?.kill()
      handoffTween?.kill()
      Object.assign(anim, INITIAL_STATE)
      motion.orbitTime = 0
      motion.phase = 'intro'

      const { at: a1, ...p1 } = PHASE_1A
      const { at: ae, ...pe } = EPICYCLE_IN
      const { at: a2, ...p2 } = PHASE_1B
      introTl = gsap
        .timeline({ onComplete: startHandoff })
        .to(anim, p1, a1)
        .to(anim, pe, ae)
        .to(anim, p2, a2)
      introTl.timeScale(introTimeScale)
    }
    replayRef.current = () => {
      if (motion.phase !== 'loading') playIntro()
    }

    /* ── build cards (async: poster images) ────────────────────────────── */
    ;(async () => {
      posters = await loadPosterTextures(anisotropy)
      if (disposed) {
        posters.forEach((t) => t?.dispose())
        return
      }
      materials = createPosterMaterials(posters)

      for (let i = 0; i < CARD_COUNT; i++) {
        // tier 2: cardAnchor — local +Z points radially outward
        const anchor = new THREE.Group()
        anchor.rotation.y = (i / CARD_COUNT) * Math.PI * 2
        carouselPivot.add(anchor)

        // tier 3: cardMesh — flat 0-thickness plane; z = radial distance, x/y = tangent plane
        const mesh = new THREE.Mesh(geometry, materials[i % materials.length])
        anchor.add(mesh)

        cards.push({
          anchor,
          mesh,
          orbitPhase: (i / CARD_COUNT) * Math.PI * 4,
          orbitRadius: lerpRange(ORBIT_RADIUS_RANGE, seeded(i, 1)),
          scatterRadiusOffset: lerpRange(SCATTER_RANGE, seeded(i, 2)),
        })
      }
      renderer.compile(scene, camera) // upload textures before the burst
      playIntro()
    })()

    /* ── input ─────────────────────────────────────────────────────────── */
    const isLive = () => motion.phase === 'handoff' || motion.phase === 'interactive'
    let dragging = false
    let lastX = 0
    let lastT = 0
    let velocity = 0 // rad / ms
    let wheelTimer = 0

    const dragRadPerPx = () => (STEP * DRAG_CARDS_PER_SCREEN) / Math.max(mount.clientWidth, 1)

    const onPointerDown = (e: PointerEvent) => {
      if (!isLive() || e.button !== 0) return
      takeControl()
      dragging = true
      lastX = e.clientX
      lastT = performance.now()
      velocity = 0
      mount.setPointerCapture(e.pointerId)
      mount.style.cursor = 'grabbing'
    }

    const onPointerMove = (e: PointerEvent) => {
      motion.parallaxTarget = ((e.clientY / window.innerHeight) * 2 - 1) * PARALLAX_MAX
      if (!dragging) return
      const now = performance.now()
      const delta = (e.clientX - lastX) * dragRadPerPx()
      motion.target += delta
      const dtm = now - lastT
      if (dtm > 0) velocity = velocity * 0.4 + (delta / dtm) * 0.6
      lastX = e.clientX
      lastT = now
      motion.lastInteraction = now
    }

    const onPointerUp = (e: PointerEvent) => {
      if (!dragging) return
      dragging = false
      if (mount.hasPointerCapture(e.pointerId)) mount.releasePointerCapture(e.pointerId)
      mount.style.cursor = 'grab'
      if (performance.now() - lastT > 90) velocity = 0 // held still before release
      const fling = THREE.MathUtils.clamp(velocity * DRAG_INERTIA_MS, -STEP * MAX_FLING_CARDS, STEP * MAX_FLING_CARDS)
      motion.target = snap(motion.target + fling) // always land with a card dead-centre
      motion.lastInteraction = performance.now()
    }

    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      if (!isLive()) return
      takeControl()
      const scale = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? window.innerHeight : 1
      const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY
      motion.target -= d * scale * WHEEL_RAD_PER_PX
      window.clearTimeout(wheelTimer)
      wheelTimer = window.setTimeout(() => {
        motion.target = snap(motion.target)
      }, WHEEL_SNAP_DELAY_MS)
    }

    const onKey = (e: KeyboardEvent) => {
      if (!isLive()) return
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        takeControl()
        motion.target = snap(motion.target) + (e.key === 'ArrowLeft' ? STEP : -STEP)
      }
    }

    mount.addEventListener('pointerdown', onPointerDown)
    mount.addEventListener('pointerup', onPointerUp)
    mount.addEventListener('pointercancel', onPointerUp)
    mount.addEventListener('wheel', onWheel, { passive: false })
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('keydown', onKey)
    window.addEventListener('resize', resize)

    /* ── frame loop — mutates Three.js objects only, never React state ── */
    let lastFrame = performance.now()
    renderer.setAnimationLoop(() => {
      const now = performance.now()
      const dt = Math.min((now - lastFrame) / 1000, 1 / 20)
      lastFrame = now

      if (motion.phase === 'intro') {
        motion.rotY += anim.spinSpeed * dt
      } else if (motion.phase === 'interactive') {
        // Idle drift: advance one card at a time so a card is always centred.
        if (!dragging && now - motion.lastInteraction > AUTO_ADVANCE_MS) {
          motion.target = snap(motion.target) + STEP
          motion.lastInteraction = now
        }
        motion.rotY += (motion.target - motion.rotY) * damp(ROTATION_DAMPING, dt)
      }
      // 'handoff': rotY is driven by the GSAP tween.

      const live = isLive() ? 1 : 0
      motion.blend += (live - motion.blend) * damp(BLEND_DAMPING, dt)
      motion.parallax += (motion.parallaxTarget - motion.parallax) * damp(PARALLAX_DAMPING, dt)

      carouselPivot.rotation.x = anim.tiltX + motion.blend * (REST_TILT_X + motion.parallax)
      carouselPivot.rotation.y = motion.rotY
      carouselPivot.rotation.z = anim.tiltZ

      // Epicyclic micro-orbits in each anchor's tangent plane.
      motion.orbitTime += anim.orbitSpeed * dt
      const e = anim.epicycleAmount
      for (const card of cards) {
        const theta = motion.orbitTime + card.orbitPhase
        card.mesh.position.set(
          Math.cos(theta) * card.orbitRadius * e,
          Math.sin(theta) * card.orbitRadius * e,
          anim.radius + card.scatterRadiusOffset * e,
        )
        card.mesh.scale.setScalar(anim.cardScale)
      }

      // Camera dolly (pulled back further on portrait screens).
      camera.position.z = PHASE_1B.radius + (anim.camZ - PHASE_1B.radius) * viewFit
      camera.lookAt(0, 0, 0)
      fog.near = camera.position.z + FOG.nearOffset
      fog.far = camera.position.z + FOG.farOffset

      // HUD counter — touch the DOM only when the centred card changes.
      const idx = (((-Math.round(motion.rotY / STEP)) % CARD_COUNT) + CARD_COUNT) % CARD_COUNT
      if (idx !== motion.activeIndex && counterRef?.current) {
        motion.activeIndex = idx
        counterRef.current.textContent = `${pad2(idx + 1)} / ${pad2(CARD_COUNT)}`
      }

      renderer.render(scene, camera)
    })

    /* ── cleanup ───────────────────────────────────────────────────────── */
    return () => {
      disposed = true
      renderer.setAnimationLoop(null)
      introTl?.kill()
      handoffTween?.kill()
      window.clearTimeout(wheelTimer)
      mount.removeEventListener('pointerdown', onPointerDown)
      mount.removeEventListener('pointerup', onPointerUp)
      mount.removeEventListener('pointercancel', onPointerUp)
      mount.removeEventListener('wheel', onWheel)
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', resize)
      materials.forEach((m) => m.dispose())
      posters.forEach((t) => t?.dispose())
      geometry.dispose()
      renderer.dispose()
      renderer.domElement.remove()
    }
  }, [counterRef])

  return <div ref={mountRef} className="fixed inset-0 z-0 h-screen w-screen cursor-grab" />
})

export default MagazineCarousel
