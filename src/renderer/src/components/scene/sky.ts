import * as THREE from 'three';

/**
 * A Roblox-like sky: a horizon-to-zenith gradient whose colors come from the place's Atmosphere and
 * time of day (warm at sunset), a sun disc with glow, and drifting clouds from Terrain.Clouds. Drawn on
 * a large sphere that follows the camera, behind everything, unaffected by fog.
 */
export class GradientSky {
  readonly mesh: THREE.Mesh<THREE.SphereGeometry, THREE.ShaderMaterial>;

  constructor() {
    const material = new THREE.ShaderMaterial({
      uniforms: {
        uZenith: { value: new THREE.Color(0x2f6fd1) },
        uHorizon: { value: new THREE.Color(0xa9cbe8) },
        uGround: { value: new THREE.Color(0x3a3530) },
        uSunDir: { value: new THREE.Vector3(0.3, 0.8, 0.2) },
        uSunColor: { value: new THREE.Color(1, 0.95, 0.85) },
        uSunSize: { value: 0.0012 },
        uGlow: { value: 1 },
        uCloudCover: { value: 0 },
        uCloudColor: { value: new THREE.Color(1, 1, 1) },
        uTime: { value: 0 },
      },
      vertexShader: `
        varying vec3 vDir;
        void main() {
          vDir = position;
          vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          gl_Position = p.xyww;
        }`,
      fragmentShader: `
        uniform vec3 uZenith; uniform vec3 uHorizon; uniform vec3 uGround; uniform vec3 uSunDir; uniform vec3 uSunColor;
        uniform float uSunSize; uniform float uGlow; uniform float uCloudCover; uniform vec3 uCloudColor; uniform float uTime;
        varying vec3 vDir;
        float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
        float noise(vec2 p) {
          vec2 i = floor(p), f = fract(p);
          float a = hash(i), b = hash(i + vec2(1.0, 0.0)), c = hash(i + vec2(0.0, 1.0)), d = hash(i + vec2(1.0, 1.0));
          vec2 u = f * f * (3.0 - 2.0 * f);
          return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
        }
        float fbm(vec2 p) { float v = 0.0, a = 0.5; for (int i = 0; i < 5; i++) { v += a * noise(p); p *= 2.03; a *= 0.5; } return v; }
        void main() {
          vec3 d = normalize(vDir);
          float h = d.y;
          vec3 col = mix(uHorizon, uZenith, pow(clamp(h, 0.0, 1.0), 0.5));
          col = mix(col, uGround, smoothstep(0.0, -0.2, h));
          float s = max(dot(d, normalize(uSunDir)), 0.0);
          col += uSunColor * (pow(s, 8.0) * 0.1 + pow(s, 64.0) * 0.35) * uGlow;
          col += uSunColor * smoothstep(1.0 - uSunSize * 1.6, 1.0 - uSunSize, s) * 3.0 * step(0.0, h + 0.02);
          if (h > 0.0 && uCloudCover > 0.0) {
            vec2 uv = d.xz / (h + 0.15) * 1.4 + vec2(uTime * 0.004, uTime * 0.002);
            float c = fbm(uv * 1.2);
            float cover = smoothstep(1.0 - uCloudCover * 0.85, 1.12 - uCloudCover * 0.6, c);
            vec3 cc = uCloudColor * (0.72 + 0.28 * smoothstep(0.35, 0.9, c)) + uSunColor * pow(s, 5.0) * 0.25;
            col = mix(col, cc, cover * smoothstep(0.0, 0.12, h) * 0.92);
          }
          gl_FragColor = vec4(col, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      toneMapped: true,
    });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24), material);
    this.mesh.scale.setScalar(9000);
    this.mesh.renderOrder = -1;
    this.mesh.frustumCulled = false;
  }

  get uniforms() {
    return this.mesh.material.uniforms as Record<string, { value: unknown }>;
  }

  follow(camera: THREE.Camera, t: number): void {
    this.mesh.position.copy(camera.position);
    this.uniforms.uTime!.value = t;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}
