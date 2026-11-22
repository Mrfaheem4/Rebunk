import { forwardRef, useEffect, useImperativeHandle, useRef, type RefObject } from 'react'
import * as THREE from 'three'
import gsap from 'gsap'
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

/* ══════════════════════════════════════════════════════════════════════════ */

export type CarouselHandle = { replay: () => void }

type Props = {
  /** Kept for API compatibility with App; unused in the simple disk. */
  counterRef?: RefObject<HTMLSpanElement | null>
}

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

const MagazineCarousel = forwardRef<CarouselHandle, Props>(function MagazineCarousel(_props, ref) {
  const mountRef = useRef<HTMLDivElement>(null)

  useImperativeHandle(ref, () => ({ replay: () => {} }), [])

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
        gsap.to(disk.rotation, { y: target, duration: ((Math.PI / 2) * gap) / SPIN_SPEED, ease: 'sine.out' }),
        expandTl.time(),
      )
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
      const meshes: THREE.Mesh[] = []
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

      // Approach: keep dollying in (and levelling to the horizon) all the way
      // until the front card sits in the centre of the screen.
      expandTl
        .to(camera.position, { z: APPROACH.cameraZ, duration: landAt, ease: APPROACH.ease }, 0)
        .to(disk.rotation, { x: APPROACH.tiltX, duration: landAt, ease: APPROACH.ease }, 0)
    })()

    const resize = () => {
      renderer.setSize(mount.clientWidth, mount.clientHeight)
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
      renderer.render(scene, camera)
    })

    return () => {
      disposed = true
      renderer.setAnimationLoop(null)
      expandTl?.kill()
      paceTween?.kill()
      window.removeEventListener('resize', resize)
      materials.forEach((m) => m.dispose())
      posters.forEach((t) => t?.dispose())
      geometry.dispose()
      renderer.dispose()
      renderer.domElement.remove()
    }
  }, [])

  return <div ref={mountRef} className="fixed inset-0 z-0 h-screen w-screen" />
})

export default MagazineCarousel
