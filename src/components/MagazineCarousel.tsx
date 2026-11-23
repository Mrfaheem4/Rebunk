import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import gsap from 'gsap'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { BokehPass } from 'three/examples/jsm/postprocessing/BokehPass.js'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'
import { POSTER_URLS, createPosterMaterials, loadPosterTextures } from '../lib/cardTextures'

/* ══════════════════════════════════════════════════════════════════════════
 * TUNING — a simple tilted disk of cards, spinning in the distance.
 * ══════════════════════════════════════════════════════════════════════════ */

/** How many times the 4 posters repeat around the ring (3 → 12 cards). */
const POSTER_REPEATS = 3
const CARD_COUNT = POSTER_URLS.length * POSTER_REPEATS
const CARD_SIZE = { w: 2.2, h: 3.1 } // flat plane, zero thickness

const CAMERA_FOV = 62
const CAMERA_Z = 34 // far away
const DISK_RADIUS = 4.6
const TILT_X = 0.35 // ~20° pitched forward — lower = more edge-on (horizon up)
const TILT_Z = 0.42 // ~24° diagonal roll
const SPIN_SPEED = 0.9 // rad/s

/** Cards start as thin slivers (full width, ~2–3px tall) and expand to full height. */
const SQUISH_SCALE_Y = 0.04
const EXPAND = { delay: 0.5, duration: 1.4, ease: 'power2.in' } // accelerates into the explosion — no slow tail
/** During the expand, the ring widens (more spacing) and rolls back (right side down, left side up). */
const EXPANDED_RADIUS = 6.2
const EXPANDED_TILT_Z = 0.1

/**
 * Explosion (after the expand): each card follows its own curved path, randomly
 * up or down out of the disk plane, while the disk keeps spinning.
 * All distances are in disk-local units; ranges are [min, max].
 */
const EXPLODE = {
  delay: -0.12, // seconds relative to the expand finishing — negative = slight overlap
  duration: 1.8,
  ease: 'power2.out',
  stagger: 0, // max random start offset per card (0 = all launch together)
  height: [4, 8.5] as [number, number], // how far up/down each card travels
  outward: [0.8, 2.8] as [number, number], // extra radial push away from the centre
  sideways: [-1, 1] as [number, number], // drift along the ring
}

/**
 * Return: after reaching the end of its path, each card travels back along the
 * same path into its ring slot — the ring becomes the carousel.
 */
const RETURN = {
  hold: 0.6, // pause at the far end of the path before coming back (timeline seconds — ÷ PACE.speed for real time)
  duration: 1.8,
  ease: 'power2.inOut',
}

/** Final carousel state — reached as the cards land back in the ring. */
/** Ring radius the cards land on at the end (smaller than EXPANDED_RADIUS = tighter carousel). */
const FINAL_RADIUS = 5

const CAROUSEL = {
  tiltZ: 0, // level the diagonal roll
  settle: 1.6, // seconds the roll levels / spin brakes, ending around the landing
}
const STEP = (Math.PI * 2) / CARD_COUNT // angle between neighbouring cards

/**
 * Approach: runs across the whole sequence (expand → explode → return). The
 * camera dollies in while the disk levels out to the horizon (tilt X → 0).
 */
const APPROACH = {
  ease: 'power2.inOut',
  cameraZ: FINAL_RADIUS + 2.9, // final camera distance — 2.9 in front of the centre card so it fills the screen
  tiltX: 0, // final forward tilt — 0 = camera on the horizon
}

/**
 * Pace: plays the whole sequence (cards, spin, camera) faster, then eases back
 * down to normal speed as the cards land, so it glides into the carousel.
 */
const PACE = {
  speed: 2.4, // overall speed multiplier during the sequence
  slowTo: 0.6, // speed it eases down to while settling into the carousel
  slowDuration: 1.4, // real seconds the slow-down takes (starts as the cards begin landing)
}

/**
 * Depth of field: the front card stays sharp; blur grows with distance behind it.
 * Blur ≈ depthBehindFrontCard × aperture (in screen-UV units), capped at maxBlur.
 */
const DEPTH = {
  aperture: 0.0002, // subtle — higher = shallower focus, back cards blur more
  fadeIn: 1.6, // seconds the blur takes to fade in once the carousel has settled
  maxBlur: 0.003, // cap so the far side never turns to mush
}

/** Drag to rotate — enabled once the intro has landed on the carousel. */
const DRAG = {
  cardsPerScreen: 3, // dragging a full screen width turns this many cards
  inertiaMs: 520, // release velocity is projected this far ahead before snapping (more = longer glide)
  maxFlingCards: 8,
  damping: 0.055, // how quickly the ring follows the drag target (per 60fps frame; lower = heavier, floatier)
}

/** Custom cursor: deep-red circle with bold "DRAG" that replaces the pointer on the whole page. */
const CURSOR = {
  size: 88, // px diameter of the "DRAG" circle (over a card)
  dotSize: 12, // px diameter of the dot (everywhere else)
  color: '#ff1a1a', // bright red
  follow: 1, // how tightly it trails the mouse (per 60fps frame; 1 = locked to the pointer, lower = smooth trail)
  grow: 0.2, // how fast it pops in / out
}

/* ══════════════════════════════════════════════════════════════════════════ */

const rand = ([a, b]: [number, number]) => a + Math.random() * (b - a)

/** A random curved path for one card: bows outward first, then sweeps up or down. */
const makePath = () => {
  const dir = Math.random() < 0.5 ? 1 : -1
  const height = rand(EXPLODE.height) * dir
  const outward = rand(EXPLODE.outward)
  const sideways = rand(EXPLODE.sideways)
  const start = new THREE.Vector3(0, 0, EXPANDED_RADIUS)
  const control = new THREE.Vector3(sideways * 0.3, height * 0.15, EXPANDED_RADIUS + outward * 0.9)
  const end = new THREE.Vector3(sideways, height, EXPANDED_RADIUS + outward)
  return new THREE.QuadraticBezierCurve3(start, control, end)
}

type Props = {
  /** Fired once, as the exploded cards start settling into the carousel. */
  onReveal?: () => void
}

export default function MagazineCarousel({ onReveal }: Props) {
  const mountRef = useRef<HTMLDivElement>(null)
  const cursorRef = useRef<HTMLDivElement>(null)
  const cursorLabelRef = useRef<HTMLSpanElement>(null)
  const onRevealRef = useRef(onReveal)
  useEffect(() => {
    onRevealRef.current = onReveal
  }, [onReveal])

  useEffect(() => {
    const mount = mountRef.current!
    let disposed = false

    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.setSize(mount.clientWidth, mount.clientHeight)
    renderer.setClearColor(0x000000, 1)
    renderer.outputColorSpace = THREE.SRGBColorSpace
    renderer.domElement.style.display = 'block'
    mount.appendChild(renderer.domElement)
    const anisotropy = renderer.capabilities.getMaxAnisotropy()

    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(CAMERA_FOV, mount.clientWidth / mount.clientHeight, 0.1, 100)
    camera.position.set(0, 0, CAMERA_Z)
    camera.lookAt(0, 0, 0)

    // Disk: spin around its own axis (Y) first, then the fixed tilt (Z, X).
    const disk = new THREE.Group()
    disk.rotation.order = 'XZY'
    disk.rotation.x = TILT_X
    disk.rotation.z = TILT_Z
    scene.add(disk)

    const geometry = new THREE.PlaneGeometry(CARD_SIZE.w, CARD_SIZE.h)
    let posters: (THREE.Texture | null)[] = []
    let materials: THREE.Material[] = []
    let expandTl: gsap.core.Timeline | null = null
    const spin = { speed: SPIN_SPEED }
    /** Overall playback speed — scales the main timeline and the free spin together. */
    const pace = { value: PACE.speed }
    let paceTween: gsap.core.Tween | null = null

    const slowIntoCarousel = () => {
      paceTween = gsap.to(pace, { value: PACE.slowTo, duration: PACE.slowDuration, ease: 'power2.out' })
    }

    // Brake the spin so it stops exactly with a card facing the camera.
    // sine.out starts at velocity (π/2)·gap/duration — matched to the spin
    // speed, so there's no jolt. The tween lives inside the main timeline so
    // the pace multiplier applies to it too.
    const brakeToCard = () => {
      if (!expandTl) return
      const rot = disk.rotation.y
      const desiredGap = (SPIN_SPEED * CAROUSEL.settle * 2) / Math.PI
      const target = Math.ceil((rot + desiredGap) / STEP) * STEP
      const gap = target - rot
      spin.speed = 0
      expandTl.add(
        gsap.to(disk.rotation, {
          y: target,
          duration: ((Math.PI / 2) * gap) / SPIN_SPEED,
          ease: 'sine.out',
          onComplete: () => {
            drag.target = disk.rotation.y
            drag.enabled = true
            // carousel established → ease the depth blur in
            depthTween = gsap.to(depth, { amount: 1, duration: DEPTH.fadeIn, ease: 'power2.inOut' })
          },
        }),
        expandTl.time(),
      )
    }

    /* ── drag to rotate ─────────────────────────────────────────────── */
    const depth = { amount: 0 } // 0 = no blur during the intro, 1 = full depth of field
    let depthTween: gsap.core.Tween | null = null
    const drag = { enabled: false, active: false, target: 0, lastX: 0, lastT: 0, velocity: 0 }
    const snapToCard = (rot: number) => Math.round(rot / STEP) * STEP
    const radPerPx = () => (STEP * DRAG.cardsPerScreen) / Math.max(mount.clientWidth, 1)
    renderer.domElement.style.touchAction = 'none'

    const onDragStart = (e: PointerEvent) => {
      if (!drag.enabled || e.button !== 0) return
      drag.active = true
      drag.lastX = e.clientX
      drag.lastT = performance.now()
      drag.velocity = 0
      mount.setPointerCapture(e.pointerId)
    }
    const onDragMove = (e: PointerEvent) => {
      if (!drag.active) return
      const now = performance.now()
      const delta = (e.clientX - drag.lastX) * radPerPx()
      drag.target += delta
      const dtm = now - drag.lastT
      if (dtm > 0) drag.velocity = drag.velocity * 0.4 + (delta / dtm) * 0.6
      drag.lastX = e.clientX
      drag.lastT = now
    }
    const onDragEnd = (e: PointerEvent) => {
      if (!drag.active) return
      drag.active = false
      if (mount.hasPointerCapture(e.pointerId)) mount.releasePointerCapture(e.pointerId)
      if (performance.now() - drag.lastT > 90) drag.velocity = 0 // held still before letting go
      const maxFling = STEP * DRAG.maxFlingCards
      const fling = THREE.MathUtils.clamp(drag.velocity * DRAG.inertiaMs, -maxFling, maxFling)
      drag.target = snapToCard(drag.target + fling) // always land with a card centred
    }
    mount.addEventListener('pointerdown', onDragStart)
    mount.addEventListener('pointermove', onDragMove)
    mount.addEventListener('pointerup', onDragEnd)
    mount.addEventListener('pointercancel', onDragEnd)

    /* ── custom cursor: small red dot, grows into a "DRAG" circle over a card ── */
    const cardMeshes: THREE.Mesh[] = []
    const cursorEl = cursorRef.current!
    const cursorLabel = cursorLabelRef.current!
    const raycaster = new THREE.Raycaster()
    const pointerNdc = new THREE.Vector2()
    // Hide the native pointer everywhere (incl. buttons) while this is mounted.
    const hideCursorStyle = document.createElement('style')
    hideCursorStyle.textContent = '*, *::before, *::after { cursor: none !important; }'
    document.head.appendChild(hideCursorStyle)
    const pointer = { x: 0, y: 0, inside: false }
    const cursor = { x: 0, y: 0, visible: 0, hover: 0 }

    const onPointerMove = (e: PointerEvent) => {
      pointer.x = e.clientX
      pointer.y = e.clientY
      if (!pointer.inside) {
        cursor.x = e.clientX // first move: appear under the mouse, don't fly in
        cursor.y = e.clientY
      }
      pointer.inside = true
    }
    const onPointerLeave = () => {
      pointer.inside = false
    }
    window.addEventListener('pointermove', onPointerMove)
    document.documentElement.addEventListener('pointerleave', onPointerLeave)

    const updateCursor = (dt: number) => {
      let hovering = false
      if (pointer.inside && cardMeshes.length) {
        pointerNdc.set((pointer.x / mount.clientWidth) * 2 - 1, -(pointer.y / mount.clientHeight) * 2 + 1)
        raycaster.setFromCamera(pointerNdc, camera)
        hovering = raycaster.intersectObjects(cardMeshes, false).length > 0
      }
      const follow = 1 - Math.pow(1 - CURSOR.follow, dt * 60)
      const grow = 1 - Math.pow(1 - CURSOR.grow, dt * 60)
      cursor.x += (pointer.x - cursor.x) * follow
      cursor.y += (pointer.y - cursor.y) * follow
      cursor.visible += ((pointer.inside ? 1 : 0) - cursor.visible) * grow
      cursor.hover += ((hovering ? 1 : 0) - cursor.hover) * grow
      // dot size → full circle size as hover goes 0 → 1
      const dotScale = CURSOR.dotSize / CURSOR.size
      const scale = (dotScale + (1 - dotScale) * cursor.hover) * cursor.visible
      cursorEl.style.transform = `translate3d(${cursor.x}px, ${cursor.y}px, 0) translate(-50%, -50%) scale(${scale})`
      cursorLabel.style.opacity = String(Math.max(0, (cursor.hover - 0.4) / 0.6)) // text fades in late
    }

    ;(async () => {
      posters = await loadPosterTextures(anisotropy)
      if (disposed) {
        posters.forEach((t) => t?.dispose())
        return
      }
      materials = createPosterMaterials(posters)
      const meshScales: THREE.Vector3[] = []
      const meshPositions: THREE.Vector3[] = []
      const meshes = cardMeshes
      for (let i = 0; i < CARD_COUNT; i++) {
        const anchor = new THREE.Group()
        anchor.rotation.y = (i / CARD_COUNT) * Math.PI * 2
        const mesh = new THREE.Mesh(geometry, materials[i % materials.length])
        mesh.position.z = DISK_RADIUS
        mesh.scale.y = SQUISH_SCALE_Y
        meshScales.push(mesh.scale)
        meshPositions.push(mesh.position)
        meshes.push(mesh)
        anchor.add(mesh)
        disk.add(anchor)
      }
      expandTl = gsap
        .timeline({ delay: EXPAND.delay, defaults: { duration: EXPAND.duration, ease: EXPAND.ease } })
        .to(meshScales, { y: 1 }, 0)
        // ring widening finishes exactly when the explosion takes over the positions
        .to(meshPositions, { z: EXPANDED_RADIUS, duration: EXPAND.duration + Math.min(EXPLODE.delay, 0) }, 0)
        .to(disk.rotation, { z: EXPANDED_TILT_Z }, 0)

      // Explosion: every card travels along its own random up/down path.
      // Explode right after the expand finishes.
      const explodeAt = EXPAND.duration + EXPLODE.delay
      // Then each card comes back along the same path into its ring slot.
      const returnAt = explodeAt + EXPLODE.stagger + EXPLODE.duration + RETURN.hold
      const landAt = returnAt + RETURN.duration
      // Shrink the ring to FINAL_RADIUS while the cards come back.
      const ring = { shrink: 0 }
      expandTl.to(ring, { shrink: EXPANDED_RADIUS - FINAL_RADIUS, duration: RETURN.duration, ease: RETURN.ease }, returnAt)
      for (const mesh of meshes) {
        const path = makePath()
        const progress = { t: 0 }
        const follow = () => {
          path.getPoint(progress.t, mesh.position)
          mesh.position.z -= ring.shrink // pulls the ring tighter during the return
        }
        expandTl
          .to(
            progress,
            { t: 1, duration: EXPLODE.duration, ease: EXPLODE.ease, onUpdate: follow },
            explodeAt + Math.random() * EXPLODE.stagger,
          )
          .to(progress, { t: 0, duration: RETURN.duration, ease: RETURN.ease, onUpdate: follow }, returnAt)
      }

      // Carousel: level the roll and brake the spin onto a card as the cards land.
      const settleAt = landAt - CAROUSEL.settle
      expandTl
        .to(disk.rotation, { z: CAROUSEL.tiltZ, duration: CAROUSEL.settle, ease: 'power2.inOut' }, settleAt)
        .call(brakeToCard, [], settleAt)
        .call(slowIntoCarousel, [], settleAt)
        .call(() => onRevealRef.current?.(), [], settleAt) // HUD (logo + title) animates in with the carousel

      // Approach: keep dollying in (and levelling to the horizon) all the way
      // until the front card sits in the centre of the screen.
      expandTl
        .to(camera.position, { z: APPROACH.cameraZ, duration: landAt, ease: APPROACH.ease }, 0)
        .to(disk.rotation, { x: APPROACH.tiltX, duration: landAt, ease: APPROACH.ease }, 0)
    })()

    /* ── depth of field: front card sharp, cards further back blur ─────── */
    const composer = new EffectComposer(renderer)
    composer.renderTarget1.samples = 4 // keep MSAA edges through the post chain
    composer.renderTarget2.samples = 4
    composer.addPass(new RenderPass(scene, camera))
    const bokeh = new BokehPass(scene, camera, {
      focus: CAMERA_Z - FINAL_RADIUS,
      aperture: DEPTH.aperture,
      maxblur: DEPTH.maxBlur,
    })
    composer.addPass(bokeh)
    const bokehUniforms = bokeh.uniforms as Record<string, THREE.IUniform<number>>
    const bokehFocus = bokehUniforms.focus
    const bokehAperture = bokehUniforms.aperture
    composer.addPass(new OutputPass()) // sRGB conversion after the blur
    composer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    composer.setSize(mount.clientWidth, mount.clientHeight)

    const resize = () => {
      renderer.setSize(mount.clientWidth, mount.clientHeight)
      composer.setSize(mount.clientWidth, mount.clientHeight)
      camera.aspect = mount.clientWidth / mount.clientHeight
      camera.updateProjectionMatrix()
    }
    window.addEventListener('resize', resize)

    let last = performance.now()
    renderer.setAnimationLoop(() => {
      const now = performance.now()
      const dt = Math.min((now - last) / 1000, 1 / 20)
      last = now
      expandTl?.timeScale(pace.value)
      disk.rotation.y += spin.speed * pace.value * dt
      if (drag.enabled) {
        disk.rotation.y += (drag.target - disk.rotation.y) * (1 - Math.pow(1 - DRAG.damping, dt * 60))
      }
      updateCursor(dt)
      // Keep the focal plane on the front of the ring as the camera dollies in.
      bokehFocus.value = camera.position.z - FINAL_RADIUS
      bokehAperture.value = DEPTH.aperture * depth.amount
      bokeh.enabled = depth.amount > 0.001 // no blur (and no cost) until the carousel settles
      composer.render(dt)
    })

    return () => {
      disposed = true
      renderer.setAnimationLoop(null)
      expandTl?.kill()
      paceTween?.kill()
      depthTween?.kill()
      window.removeEventListener('resize', resize)
      window.removeEventListener('pointermove', onPointerMove)
      mount.removeEventListener('pointerdown', onDragStart)
      mount.removeEventListener('pointermove', onDragMove)
      mount.removeEventListener('pointerup', onDragEnd)
      mount.removeEventListener('pointercancel', onDragEnd)
      document.documentElement.removeEventListener('pointerleave', onPointerLeave)
      hideCursorStyle.remove()
      materials.forEach((m) => m.dispose())
      posters.forEach((t) => t?.dispose())
      geometry.dispose()
      bokeh.dispose()
      composer.dispose()
      renderer.dispose()
      renderer.domElement.remove()
    }
  }, [])

  return (
    <>
      <div ref={mountRef} className="fixed inset-0 z-0 h-screen w-screen" />
      {/* Custom hover cursor — positioned/scaled every frame by the loop above. */}
      <div
        ref={cursorRef}
        aria-hidden
        className="pointer-events-none fixed left-0 top-0 z-20 flex select-none items-center justify-center rounded-full font-sans text-[0.875rem] font-bold uppercase tracking-[-0.04em] text-black"
        style={{ width: CURSOR.size, height: CURSOR.size, backgroundColor: CURSOR.color, transform: 'scale(0)', willChange: 'transform' }}
      >
        <span ref={cursorLabelRef} style={{ opacity: 0 }}>
          Drag
        </span>
      </div>
    </>
  )
}
