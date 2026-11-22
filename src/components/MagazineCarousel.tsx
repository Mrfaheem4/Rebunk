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
  delay: 0, // seconds after the expand FINISHES — 0 = explode the instant it completes
  duration: 1.8,
  ease: 'power2.out',
  stagger: 0, // max random start offset per card (0 = all launch together)
  height: [6, 12.5] as [number, number], // how far up/down each card travels
  outward: [1.2, 4] as [number, number], // extra radial push away from the centre
  sideways: [-1.5, 1.5] as [number, number], // drift along the ring
}

/**
 * Approach: runs across the whole expand + explosion. The camera dollies in
 * while the disk levels out to the horizon (tilt X → 0).
 */
const APPROACH = {
  ease: 'power2.inOut',
  cameraZ: 18, // final camera distance (starts at CAMERA_Z)
  tiltX: 0, // final forward tilt — 0 = camera on the horizon
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
        .to(meshPositions, { z: EXPANDED_RADIUS }, 0)
        .to(disk.rotation, { z: EXPANDED_TILT_Z }, 0)

      // Explosion: every card travels along its own random up/down path.
      // Explode right after the expand finishes.
      const explodeAt = EXPAND.duration + EXPLODE.delay
      for (const mesh of meshes) {
        const path = makePath()
        const progress = { t: 0 }
        expandTl.to(
          progress,
          {
            t: 1,
            duration: EXPLODE.duration,
            ease: EXPLODE.ease,
            onUpdate: () => path.getPoint(progress.t, mesh.position),
          },
          explodeAt + Math.random() * EXPLODE.stagger,
        )
      }

      // Approach: dolly in + level to the horizon over the entire sequence.
      const approachDuration = explodeAt + EXPLODE.stagger + EXPLODE.duration
      expandTl
        .to(camera.position, { z: APPROACH.cameraZ, duration: approachDuration, ease: APPROACH.ease }, 0)
        .to(disk.rotation, { x: APPROACH.tiltX, duration: approachDuration, ease: APPROACH.ease }, 0)
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
      disk.rotation.y += SPIN_SPEED * dt
      renderer.render(scene, camera)
    })

    return () => {
      disposed = true
      renderer.setAnimationLoop(null)
      expandTl?.kill()
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
