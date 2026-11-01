import * as THREE from 'three';
import { afterEach, describe, expect, it } from 'vitest';
import { StudioCamera } from '../../src/renderer/src/components/scene/studio-camera';

type Listener = (e: Record<string, unknown>) => void;

/** The viewer's camera on a stand-in canvas: `ahead` is how far the surface in front is (null: nothing). */
function rig(ahead: number | null) {
  const on = new Map<string, Listener>();
  const onWindow = new Map<string, Listener>();
  const el = {
    tabIndex: 0,
    style: {},
    clientHeight: 600,
    addEventListener: (t: string, f: Listener) => on.set(t, f),
    removeEventListener: () => undefined,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
    focus: () => undefined,
  };
  const g = globalThis as Record<string, unknown>;
  g.window = { addEventListener: (t: string, f: Listener) => onWindow.set(t, f), removeEventListener: () => undefined };
  g.document = { activeElement: el, pointerLockElement: null, exitPointerLock: () => undefined };
  const camera = new THREE.PerspectiveCamera(70, 800 / 600, 0.5, 20000);
  camera.position.set(0, 3, 0);
  const cam = new StudioCamera(camera, el as unknown as HTMLElement);
  cam.lookAt(new THREE.Vector3(0, 3, -1000));
  cam.raycast = () => (ahead === null ? null : camera.position.clone().add(new THREE.Vector3(0, 0, -ahead)));
  const run = (seconds: number) => {
    for (let t = 0; t < seconds; t += 1 / 60) cam.update(1 / 60);
  };
  const wheel = (e: Record<string, unknown>) => on.get('wheel')!({ deltaX: 0, deltaY: 0, deltaMode: 0, clientX: 400, clientY: 300, shiftKey: false, preventDefault: () => undefined, ...e });
  const key = (code: string, down: boolean) => onWindow.get(down ? 'keydown' : 'keyup')!({ code, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, preventDefault: () => undefined });
  return { camera, cam, run, wheel, key };
}

afterEach(() => {
  const g = globalThis as Record<string, unknown>;
  delete g.window;
  delete g.document;
});

describe('the viewer camera', () => {
  it('flies at the same speed close to the ground as far from it', () => {
    const flown = (ahead: number | null) => {
      const r = rig(ahead);
      r.key('KeyW', true);
      r.run(1);
      return -r.camera.position.z;
    };
    const near = flown(3);
    expect(near).toBeGreaterThan(30);
    expect(flown(400)).toBeCloseTo(near, 5);
    expect(flown(null)).toBeCloseTo(near, 5);
  });

  it('flies forward and back with the wheel, the same studs per notch wherever it is', () => {
    const far = rig(500);
    far.wheel({ deltaY: -100 });
    far.run(1);
    expect(-far.camera.position.z).toBeCloseTo(12, 3);
    far.wheel({ deltaY: 200 });
    far.run(1);
    expect(-far.camera.position.z).toBeCloseTo(-12, 3);
    const open = rig(null);
    open.wheel({ deltaY: -100 });
    open.run(1);
    expect(-open.camera.position.z).toBeCloseTo(12, 3);
    // Never through the surface under the mouse; Shift (which Chromium turns sideways) is precise.
    const close = rig(5);
    close.wheel({ deltaY: -300 });
    close.run(1);
    expect(-close.camera.position.z).toBeCloseTo(3.5, 3);
    const precise = rig(500);
    precise.wheel({ deltaY: 0, deltaX: -100, shiftKey: true });
    precise.run(1);
    expect(-precise.camera.position.z).toBeCloseTo(2.4, 3);
  });

  // The viewer draws on demand (engine.ts): input asks for a frame, and it keeps drawing only while the camera moves.
  it('asks for a frame on input and comes to rest when the move is over', () => {
    const r = rig(500);
    let asked = 0;
    r.cam.onInput = () => asked++;
    expect(r.cam.moving()).toBe(false);
    r.wheel({ deltaY: -100 });
    expect(asked).toBe(1);
    expect(r.cam.moving()).toBe(true);
    r.run(2);
    expect(r.cam.moving()).toBe(false);
    r.key('KeyW', true);
    expect(asked).toBe(2);
    r.run(0.5);
    expect(r.cam.moving()).toBe(true);
    r.key('KeyW', false);
    r.run(2);
    expect(r.cam.moving()).toBe(false);
    r.cam.flyTo(new THREE.Vector3(10, 10, 10), new THREE.Vector3(0, 0, 0));
    expect(asked).toBe(3);
    expect(r.cam.moving()).toBe(true);
    r.run(1);
    expect(r.cam.moving()).toBe(false);
  });
});
