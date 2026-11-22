import * as THREE from 'three'

/* ──────────────────────────────────────────────────────────────────────────
 * Poster cards — flat, zero-thickness planes textured with the 4 posters.
 * ────────────────────────────────────────────────────────────────────────── */

export const POSTER_URLS = [
  '/posters/poster-1.png',
  '/posters/poster-2.png',
  '/posters/poster-3.png',
  '/posters/poster-4.png',
]

const FALLBACK_COLOR = 0xff3322

export async function loadPosterTextures(anisotropy: number): Promise<(THREE.Texture | null)[]> {
  const loader = new THREE.TextureLoader()
  return Promise.all(
    POSTER_URLS.map(
      (url) =>
        new Promise<THREE.Texture | null>((resolve) => {
          loader.load(
            url,
            (tex) => {
              tex.colorSpace = THREE.SRGBColorSpace
              tex.anisotropy = anisotropy
              tex.minFilter = THREE.LinearMipmapLinearFilter
              tex.generateMipmaps = true
              resolve(tex)
            },
            undefined,
            () => resolve(null),
          )
        }),
    ),
  )
}

/** One unlit, double-sided material per poster (shared by repeated cards). */
export function createPosterMaterials(posters: (THREE.Texture | null)[]) {
  return posters.map(
    (map) =>
      new THREE.MeshBasicMaterial({
        map,
        color: map ? 0xffffff : FALLBACK_COLOR,
        side: THREE.DoubleSide,
      }),
  )
}
