import { Component, type ReactNode, useEffect, useRef, useState } from 'react'

function isWebGLAvailable(): boolean {
  if (typeof document === 'undefined') return false
  try {
    const canvas = document.createElement('canvas')
        const gl =
          canvas.getContext('webgl2', { failIfMajorPerformanceCaveat: false }) ??
          canvas.getContext('webgl', { failIfMajorPerformanceCaveat: false }) ??
          canvas.getContext('experimental-webgl')
        if (!gl || !('getExtension' in gl)) return false
        const lose = gl.getExtension('WEBGL_lose_context')
    lose?.loseContext()
    return true
  } catch {
    return false
  }
}

export function LoginSceneFallback() {
  return (
    <div className="login-scene-fallback absolute inset-0 overflow-hidden" aria-hidden>
      <div className="login-scene-fallback-orb login-scene-fallback-orb-a" />
      <div className="login-scene-fallback-orb login-scene-fallback-orb-b" />
      <div className="login-scene-fallback-ring" />
    </div>
  )
}

type BoundaryProps = { children: ReactNode }
type BoundaryState = { failed: boolean }

class LoginSceneBoundary extends Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { failed: false }

  static getDerivedStateFromError(): BoundaryState {
    return { failed: true }
  }

  componentDidCatch(error: Error): void {
    console.warn('[LoginScene] WebGL scene failed, using CSS fallback:', error.message)
  }

  render(): ReactNode {
    if (this.state.failed) return <LoginSceneFallback />
    return this.props.children
  }
}

function LoginSceneWebGL() {
  const mountRef = useRef<HTMLDivElement>(null)
  const [useFallback, setUseFallback] = useState(false)

  useEffect(() => {
    if (useFallback) return

    const mount = mountRef.current
    if (!mount) return

    if (!isWebGLAvailable()) {
      setUseFallback(true)
      return
    }

    let disposed = false
    let rafId = 0
    let cleanup: (() => void) | undefined

    void (async () => {
      try {
        const THREE = await import('three')
        type ThreeMaterial = import('three').Material
        if (disposed || !mountRef.current) return

        const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
        const scene = new THREE.Scene()
        const camera = new THREE.PerspectiveCamera(52, 1, 0.1, 100)
        camera.position.set(0, 0, 18)

        const renderer = new THREE.WebGLRenderer({
          alpha: true,
          antialias: true,
          failIfMajorPerformanceCaveat: false,
          powerPreference: 'low-power',
        })
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

        const targetRotation = new THREE.Vector2(0, 0)

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
          targetRotation.set(y * 0.18, x * 0.26)
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

        cleanup = () => {
          window.cancelAnimationFrame(rafId)
          window.removeEventListener('resize', resize)
          window.removeEventListener('pointermove', onPointerMove)
          orb.geometry.dispose()
          ;(orb.material as ThreeMaterial).dispose()
          ringA.geometry.dispose()
          ;(ringA.material as ThreeMaterial).dispose()
          ringB.geometry.dispose()
          ;(ringB.material as ThreeMaterial).dispose()
          starsGeometry.dispose()
          ;(stars.material as ThreeMaterial).dispose()
          renderer.dispose()
          if (renderer.domElement.parentNode === mount) {
            mount.removeChild(renderer.domElement)
          }
        }
      } catch (error) {
        console.warn('[LoginScene] WebGL init failed, using CSS fallback:', error)
        if (!disposed) setUseFallback(true)
      }
    })()

    return () => {
      disposed = true
      cleanup?.()
    }
  }, [useFallback])

  if (useFallback) return <LoginSceneFallback />

  return <div ref={mountRef} className="absolute inset-0" aria-hidden />
}

export function LoginScene() {
  return (
    <LoginSceneBoundary>
      <LoginSceneWebGL />
    </LoginSceneBoundary>
  )
}
