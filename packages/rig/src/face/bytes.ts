/** A byte stream of numbers, strings and arrays, the arrays compressed with meshopt's lossless codecs. */

import { MeshoptDecoder } from 'meshoptimizer/decoder'

type Encoder = typeof import('meshoptimizer/encoder').MeshoptEncoder
type Typed = Int16Array | Uint16Array | Int32Array | Uint32Array | Float32Array | Uint8ClampedArray

const view = (a: Typed) => new Uint8Array(a.buffer, a.byteOffset, a.byteLength)

/** Appends numbers, strings and arrays, the arrays compressed. */
export class Writer {
  private buffer: Uint8Array<ArrayBuffer> = new Uint8Array(1 << 20)
  private length = 0

  private constructor(private readonly encoder: Encoder) {}

  /** Loads the encoder, which only writing needs. */
  static async create(): Promise<Writer> {
    const { MeshoptEncoder } = await import('meshoptimizer/encoder')
    await MeshoptEncoder.ready
    return new Writer(MeshoptEncoder)
  }

  private reserve(n: number): DataView {
    if (this.length + n > this.buffer.length) {
      const grown = new Uint8Array(Math.max(this.buffer.length * 2, this.length + n))
      grown.set(this.buffer.subarray(0, this.length))
      this.buffer = grown
    }
    const at = new DataView(this.buffer.buffer, this.length, n)
    this.length += n
    return at
  }

  u32(x: number): void { this.reserve(4).setUint32(0, x, true) }
  f64(x: number): void { this.reserve(8).setFloat64(0, x, true) }

  private bytes(bytes: Uint8Array): void {
    this.u32(bytes.length)
    this.reserve(bytes.length)
    this.buffer.set(bytes, this.length - bytes.length)
  }

  string(s: string): void { this.bytes(new TextEncoder().encode(s)) }
  array(a: Int32Array): void { this.u32(a.length); this.bytes(view(a)) }
  /** Elements of `size` bytes, a multiple of 4. */
  vertices(a: Typed, size: number): void { this.bytes(this.encoder.encodeVertexBuffer(view(a), a.byteLength / size, size)) }
  triangles(a: Uint32Array): void { this.u32(a.length); this.bytes(this.encoder.encodeIndexBuffer(view(a), a.length, 4)) }
  /** Ascending indices. */
  sequence(a: Uint32Array): void { this.u32(a.length); this.bytes(this.encoder.encodeIndexSequence(view(a), a.length, 4)) }

  finish(): Uint8Array<ArrayBuffer> {
    return this.buffer.slice(0, this.length)
  }
}

/** Reads what Writer wrote, in order. */
export class Reader {
  private readonly view: DataView
  private offset = 0

  private constructor(private readonly source: Uint8Array) {
    this.view = new DataView(source.buffer, source.byteOffset, source.byteLength)
  }

  static async create(source: Uint8Array): Promise<Reader> {
    await MeshoptDecoder.ready
    return new Reader(source)
  }

  u32(): number { return this.view.getUint32((this.offset += 4) - 4, true) }
  f64(): number { return this.view.getFloat64((this.offset += 8) - 8, true) }

  private bytes(): Uint8Array {
    const length = this.u32()
    if (this.offset + length > this.source.length) throw new Error('face: the cached face rig is truncated')
    return this.source.subarray(this.offset, (this.offset += length))
  }

  string(): string { return new TextDecoder().decode(this.bytes()) }

  array(): Int32Array {
    const out = new Int32Array(this.u32())
    const bytes = this.bytes()
    if (bytes.length !== out.byteLength) throw new Error(`face: a cached array of ${out.length} elements holds ${bytes.length} bytes`)
    view(out).set(bytes)
    return out
  }

  /** Throws unless everything was read. */
  end(): void {
    if (this.offset !== this.source.length) throw new Error(`face: the cached face rig has ${this.source.length - this.offset} bytes past its end`)
  }

  /** Fills `target` with elements of `size` bytes. */
  vertices(target: Typed, size: number): void { MeshoptDecoder.decodeVertexBuffer(view(target), target.byteLength / size, size, this.bytes()) }

  triangles(): Uint32Array {
    const out = new Uint32Array(this.u32())
    MeshoptDecoder.decodeIndexBuffer(view(out), out.length, 4, this.bytes())
    return out
  }

  sequence(): Uint32Array {
    const out = new Uint32Array(this.u32())
    MeshoptDecoder.decodeIndexSequence(view(out), out.length, 4, this.bytes())
    return out
  }
}
