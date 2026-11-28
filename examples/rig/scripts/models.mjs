import { access, rename, rm, writeFile } from 'node:fs/promises'

const three = 'https://raw.githubusercontent.com/mrdoob/three.js/dev/examples/models/gltf/'
const models = {
  parrot: `${three}Parrot.glb`,
  stork: `${three}Stork.glb`,
  soldier: `${three}Soldier.glb`,
  robot: `${three}RobotExpressive/RobotExpressive.glb`,
  fish: 'https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets/main/Models/BarramundiFish/glTF-Binary/BarramundiFish.glb',
}

await Promise.all(Object.entries(models).map(async ([name, url]) => {
  const file = new URL(`../public/rigs/${name}.glb`, import.meta.url)
  try {
    await access(file)
    return
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error
  }
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Could not download ${name}: HTTP ${response.status}`)
  const bytes = new Uint8Array(await response.arrayBuffer())
  const temporary = new URL(`${file.href}.${process.pid}.download`)
  try {
    await writeFile(temporary, bytes)
    await rename(temporary, file)
  } finally {
    await rm(temporary, { force: true })
  }
  console.log(`Downloaded ${name}.glb`)
}))
