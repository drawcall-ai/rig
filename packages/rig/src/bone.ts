import * as THREE from 'three'
import type { Vec3 } from './vec3.js'

/**
 * A THREE.Bone named `name` with its joint at `world` (world space), attached under `parent` if given
 * (parent.attach keeps the world position). The same as doing it by hand; it saves three lines per bone.
 */
export function bone(name: string, world: Vec3, parent?: THREE.Bone): THREE.Bone {
  const b = new THREE.Bone()
  b.name = name
  b.position.set(...world)
  parent?.attach(b)
  return b
}
