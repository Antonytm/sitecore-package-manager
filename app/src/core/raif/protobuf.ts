// core/raif/protobuf — just enough protobuf to read and write .raif frames.
//
// Hand-rolled rather than taking a dependency, for the same reason `core/definition` parses
// XML by hand instead of pulling in fast-xml-parser (ARCHITECTURE.md): devDependencies are
// frozen, and the subset actually used here is tiny. Only four wire types appear in the
// chunks we have — varint, fixed64, length-delimited and fixed32 — and only the first three
// are ever written.
//
// Decoding is deliberately lossless and untyped: a frame is a flat list of {no, wire, value}
// in the order it appeared. Nothing here knows what a field *means*; `items.ts` does. That
// split is what lets the round-trip oracle re-encode a real chunk without understanding it.

export const VARINT = 0 as const;
export const FIXED64 = 1 as const;
export const LENGTH = 2 as const;
export const FIXED32 = 5 as const;

export type WireType = typeof VARINT | typeof FIXED64 | typeof LENGTH | typeof FIXED32;

export interface RawField {
  no: number;
  wire: WireType;
  /** varint -> bigint; fixed64/fixed32/length-delimited -> bytes. */
  value: bigint | Uint8Array;
}

/* ------------------------------------------------------------------ reading */

class Reader {
  private i = 0;
  constructor(private readonly b: Uint8Array) {}

  get done(): boolean {
    return this.i >= this.b.length;
  }

  varint(): bigint {
    let result = 0n;
    let shift = 0n;
    for (;;) {
      if (this.i >= this.b.length) throw new Error("raif: truncated varint");
      const byte = this.b[this.i++];
      result |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return result;
      shift += 7n;
      if (shift > 63n) throw new Error("raif: varint too long");
    }
  }

  take(n: number): Uint8Array {
    if (this.i + n > this.b.length) throw new Error("raif: truncated field");
    const out = this.b.subarray(this.i, this.i + n);
    this.i += n;
    return out;
  }
}

/** Parse one protobuf message into its fields, in wire order. */
export function readMessage(bytes: Uint8Array): RawField[] {
  const r = new Reader(bytes);
  const out: RawField[] = [];
  while (!r.done) {
    const tag = Number(r.varint());
    const no = tag >>> 3;
    const wire = (tag & 7) as WireType;
    switch (wire) {
      case VARINT:
        out.push({ no, wire, value: r.varint() });
        break;
      case FIXED64:
        out.push({ no, wire, value: r.take(8) });
        break;
      case LENGTH:
        out.push({ no, wire, value: r.take(Number(r.varint())) });
        break;
      case FIXED32:
        out.push({ no, wire, value: r.take(4) });
        break;
      default:
        throw new Error("raif: unsupported wire type " + wire);
    }
  }
  return out;
}

/** First field with this number, or undefined. */
export function field(fields: RawField[], no: number): RawField | undefined {
  return fields.find((f) => f.no === no);
}

/** All fields with this number, in order. */
export function fields(all: RawField[], no: number): RawField[] {
  return all.filter((f) => f.no === no);
}

export function asBytes(f: RawField | undefined): Uint8Array | undefined {
  return f && f.value instanceof Uint8Array ? f.value : undefined;
}

export function asText(f: RawField | undefined): string | undefined {
  const b = asBytes(f);
  return b === undefined ? undefined : new TextDecoder().decode(b);
}

export function asNumber(f: RawField | undefined): bigint | undefined {
  return f && typeof f.value === "bigint" ? f.value : undefined;
}

/* ------------------------------------------------------------------ writing */

export class Writer {
  private readonly parts: Uint8Array[] = [];
  private length = 0;

  private push(bytes: Uint8Array): void {
    this.parts.push(bytes);
    this.length += bytes.length;
  }

  private raw(value: bigint): void {
    const out: number[] = [];
    let v = value;
    if (v < 0n) v += 1n << 64n; // two's complement: -1 becomes the 10-byte all-ones varint
    do {
      let byte = Number(v & 0x7fn);
      v >>= 7n;
      if (v > 0n) byte |= 0x80;
      out.push(byte);
    } while (v > 0n);
    this.push(Uint8Array.from(out));
  }

  private tag(no: number, wire: WireType): void {
    this.raw(BigInt((no << 3) | wire));
  }

  varint(no: number, value: bigint | number): this {
    this.tag(no, VARINT);
    this.raw(typeof value === "bigint" ? value : BigInt(value));
    return this;
  }

  fixed64(no: number, value: Uint8Array): this {
    if (value.length !== 8) throw new Error("raif: fixed64 needs 8 bytes");
    this.tag(no, FIXED64);
    this.push(value);
    return this;
  }

  fixed32(no: number, value: Uint8Array): this {
    if (value.length !== 4) throw new Error("raif: fixed32 needs 4 bytes");
    this.tag(no, FIXED32);
    this.push(value);
    return this;
  }

  bytes(no: number, value: Uint8Array): this {
    this.tag(no, LENGTH);
    this.raw(BigInt(value.length));
    this.push(value);
    return this;
  }

  text(no: number, value: string): this {
    return this.bytes(no, new TextEncoder().encode(value));
  }

  /** A nested message, built by the callback. */
  message(no: number, build: (w: Writer) => void): this {
    const inner = new Writer();
    build(inner);
    return this.bytes(no, inner.finish());
  }

  finish(): Uint8Array {
    const out = new Uint8Array(this.length);
    let at = 0;
    for (const part of this.parts) {
      out.set(part, at);
      at += part.length;
    }
    return out;
  }
}

/** Re-emit decoded fields verbatim — the basis of the round-trip oracle. */
export function writeMessage(all: RawField[]): Uint8Array {
  const w = new Writer();
  for (const f of all) {
    if (f.wire === VARINT) w.varint(f.no, f.value as bigint);
    else if (f.wire === FIXED64) w.fixed64(f.no, f.value as Uint8Array);
    else if (f.wire === FIXED32) w.fixed32(f.no, f.value as Uint8Array);
    else w.bytes(f.no, f.value as Uint8Array);
  }
  return w.finish();
}
