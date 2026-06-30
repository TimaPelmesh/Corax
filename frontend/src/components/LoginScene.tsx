import { useEffect, useRef } from 'react'
import * as THREE from 'three'

export function LoginScene() {
  const mountRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const mount = mountRef.current
    if (!mount) return

    const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(52, 1, 0.1, 100)
    camera.position.set(0, 0, 18)

    const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5))
    renderer.setClearColor(0x000000, 0)
    mount.appendChild(renderer.domElement)

    const root = new THREE.Group()
    scene.add(root)

    const orb = new THREE.Mesh(
      new THREE.IcosahedronGeometry(4.2, 1),
      new THREE.MeshBasicMaterial({
        color: 0xef4444,
        wireframe: true,
        transparent: true,
        opacity: 0.22,
      }),
    )
    root.add(orb)

    const ringA = new THREE.Mesh(
      new THREE.TorusGeometry(6.4, 0.08, 24, 220),
      new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0.12,
      }),
    )
    ringA.rotation.x = Math.PI * 0.45
    ringA.rotation.y = Math.PI * 0.15
    root.add(ringA)

    const ringB = new THREE.Mesh(
      new THREE.TorusGeometry(8.7, 0.05, 16, 180),
      new THREE.MeshBasicMaterial({
        color: 0xb91c1c,
        transparent: true,
        opacity: 0.2,
      }),
    )
    ringB.rotation.x = Math.PI * 0.72
    ringB.rotation.z = Math.PI * 0.14
    root.add(ringB)

    const starCount = 900
    const starPositions = new Float32Array(starCount * 3)
    const starColors = new Float32Array(starCount * 3)
    const colorA = new THREE.Color('#ffffff')
    const colorB = new THREE.Color('#ef4444')
    const mixed = new THREE.Color()

    for (let i = 0; i < starCount; i += 1) {
      const radius = 11 + Math.random() * 10
      const theta = Math.random() * Math.PI * 2
      const phi = Math.acos(2 * Math.random() - 1)
      const i3 = i * 3
      starPositions[i3] = radius * Math.sin(phi) * Math.cos(theta)
      starPositions[i3 + 1] = radius * Math.cos(phi) * 0.7
      starPositions[i3 + 2] = radius * Math.sin(phi) * Math.sin(theta)
      mixed.copy(colorA).lerp(colorB, Math.random())
      starColors[i3] = mixed.r
      starColors[i3 + 1] = mixed.g
      starColors[i3 + 2] = mixed.b
    }

    const starsGeometry = new THREE.BufferGeometry()
    starsGeometry.setAttribute('position', new THREE.BufferAttribute(starPositions, 3))
    starsGeometry.setAttribute('color', new THREE.BufferAttribute(starColors, 3))

    const stars = new THREE.Points(
      starsGeometry,
      new THREE.PointsMaterial({
        size: 0.11,
        vertexColors: true,
        transparent: true,
        opacity: 0.9,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    )
    scene.add(stars)

    const lightA = new THREE.PointLight(0xef4444, 20, 50, 2)
    lightA.position.set(-8, 5, 10)
    scene.add(lightA)

    const lightB = new THREE.PointLight(0xffffff, 9, 50, 2)
    lightB.position.set(9, -4, 12)
    scene.add(lightB)

    const pointer = new THREE.Vector2(0, 0)
    const targetRotation = new THREE.Vector2(0, 0)
    let rafId = 0

    const resize = () => {
      const width = mount.clientWidth || window.innerWidth
      const height = mount.clientHeight || window.innerHeight
      renderer.setSize(width, height, false)
      camera.aspect = width / Math.max(height, 1)
      camera.updateProjectionMatrix()
    }

    const onPointerMove = (event: PointerEvent) => {
      const x = event.clientX / window.innerWidth
      const y = event.clientY / window.innerHeight
      pointer.set(x * 2 - 1, y * 2 - 1)
      targetRotation.set(pointer.y * 0.18, pointer.x * 0.26)
    }

    const animate = () => {
      const t = performance.now() * 0.00022
      rafId = window.requestAnimationFrame(animate)

      if (!prefersReducedMotion) {
        root.rotation.x += (targetRotation.x - root.rotation.x) * 0.03
        root.rotation.y += (targetRotation.y - root.rotation.y) * 0.03
        orb.rotation.z = t * 0.8
        ringA.rotation.z = t * 0.45
        ringB.rotation.y = t * 0.32
        stars.rotation.y = t * 0.12
        stars.rotation.x = Math.sin(t * 1.4) * 0.06
      }

      renderer.render(scene, camera)
    }

    resize()
    animate()

    window.addEventListener('resize', resize)
    window.addEventListener('pointermove', onPointerMove, { passive: true })

    return () => {
      window.cancelAnimationFrame(rafId)
      window.removeEventListener('resize', resize)
      window.removeEventListener('pointermove', onPointerMove)
      orb.geometry.dispose()
      ;(orb.material as THREE.Material).dispose()
      ringA.geometry.dispose()
      ;(ringA.material as THREE.Material).dispose()
      ringB.geometry.dispose()
      ;(ringB.material as THREE.Material).dispose()
      starsGeometry.dispose()
      ;(stars.material as THREE.Material).dispose()
      renderer.dispose()
      mount.removeChild(renderer.domElement)
    }
  }, [])

  return <div ref={mountRef} className="absolute inset-0" aria-hidden />
}
