/** The gaze pad: the eyes' aim as the eight standard eyeLook weights, set by dragging, arrow keys or double-click. */

import type { Panel } from './panel.js'

const LOOKS = ['eyeLookUpLeft', 'eyeLookDownLeft', 'eyeLookInLeft', 'eyeLookOutLeft', 'eyeLookUpRight', 'eyeLookDownRight', 'eyeLookInRight', 'eyeLookOutRight']

/** Adds the Gaze section to `panel`, reading and writing the eyeLook entries of `weights`. */
export function addGazeSection(panel: Panel, weights: Map<string, number>): void {
  const look = (name: string) => weights.get(name) ?? 0
  /** The pad's position, -1..1 with right and down positive. */
  const gaze = () => ({
    x: (look('eyeLookOutLeft') - look('eyeLookInLeft') + look('eyeLookInRight') - look('eyeLookOutRight')) / 2,
    y: (look('eyeLookDownLeft') - look('eyeLookUpLeft') + look('eyeLookDownRight') - look('eyeLookUpRight')) / 2,
  })
  const setGaze = (x: number, y: number) => {
    for (const name of LOOKS) weights.delete(name)
    const set = (names: string[], value: number) => { if (value > 0) for (const n of names) weights.set(n, value) }
    // screen right is the face's left: out for its left eye, in for its right
    set(['eyeLookOutLeft', 'eyeLookInRight'], x)
    set(['eyeLookInLeft', 'eyeLookOutRight'], -x)
    set(['eyeLookDownLeft', 'eyeLookDownRight'], y)
    set(['eyeLookUpLeft', 'eyeLookUpRight'], -y)
  }

  const section = panel.section('Gaze', () => (LOOKS.some((n) => look(n)) ? 1 : 0), () => setGaze(0, 0))
  const pad = document.createElement('div')
  pad.id = 'gaze'
  pad.tabIndex = 0
  pad.title = 'Drag to aim the eyes · arrow keys nudge · double-click to center'
  pad.setAttribute('aria-label', 'Gaze direction')
  pad.dataset.filter = 'gaze eyes look'
  const aim = (x: number, y: number) => {
    setGaze(Math.min(1, Math.max(-1, x)), Math.min(1, Math.max(-1, y)))
    panel.update()
  }
  const fromPointer = (event: PointerEvent) => {
    const box = pad.getBoundingClientRect()
    aim(((event.clientX - box.left) / box.width) * 2 - 1, ((event.clientY - box.top) / box.height) * 2 - 1)
  }
  pad.addEventListener('pointerdown', (event) => {
    pad.setPointerCapture(event.pointerId)
    fromPointer(event)
  })
  pad.addEventListener('pointermove', (event) => { if (pad.hasPointerCapture(event.pointerId)) fromPointer(event) })
  pad.addEventListener('dblclick', () => aim(0, 0))
  pad.addEventListener('keydown', (event) => {
    const nudge: Record<string, [number, number]> = { ArrowLeft: [-0.1, 0], ArrowRight: [0.1, 0], ArrowUp: [0, -0.1], ArrowDown: [0, 0.1] }
    const step = nudge[event.key]
    if (!step) return
    event.preventDefault()
    const { x, y } = gaze()
    aim(x + step[0], y + step[1])
  })
  section.rows.append(pad)
  panel.onUpdate(() => {
    const { x, y } = gaze()
    pad.style.setProperty('--x', String(x))
    pad.style.setProperty('--y', String(y))
  })
}
