/**
 * SipHash-2-4 (Aumasson and Bernstein, 2012): a keyed hash built to
 * authenticate short inputs, such as the Handshake challenge, against an
 * attacker who does not know the 16-byte key. The 64-bit state words are held
 * as 32-bit halves, since BigInt arithmetic would be far slower on a path any
 * stranger can reach. Returns the 8-byte tag.
 */
export function sipHash24(key: Uint8Array, message: Uint8Array): Uint8Array {
  const keyView = new DataView(key.buffer, key.byteOffset, key.byteLength);
  const k0h = keyView.getUint32(4, true);
  const k0l = keyView.getUint32(0, true);
  const k1h = keyView.getUint32(12, true);
  const k1l = keyView.getUint32(8, true);
  const v = new SipState(
    (k0h ^ 0x736f6d65) >>> 0,
    (k0l ^ 0x70736575) >>> 0,
    (k1h ^ 0x646f7261) >>> 0,
    (k1l ^ 0x6e646f6d) >>> 0,
    (k0h ^ 0x6c796765) >>> 0,
    (k0l ^ 0x6e657261) >>> 0,
    (k1h ^ 0x74656462) >>> 0,
    (k1l ^ 0x79746573) >>> 0,
  );

  const view = new DataView(
    message.buffer,
    message.byteOffset,
    message.byteLength,
  );
  const tail = message.byteLength - (message.byteLength % 8);
  for (let offset = 0; offset < tail; offset += 8) {
    v.compress(view.getUint32(offset + 4, true), view.getUint32(offset, true));
  }
  // The last block holds the remaining bytes and, in its top byte, the message length.
  const last = new Uint8Array(8);
  last.set(message.subarray(tail));
  last[7] = message.byteLength & 0xff;
  const lastView = new DataView(last.buffer);
  v.compress(lastView.getUint32(4, true), lastView.getUint32(0, true));

  v.v2l = (v.v2l ^ 0xff) >>> 0;
  for (let round = 0; round < 4; round++) v.round();
  const tag = new Uint8Array(8);
  const tagView = new DataView(tag.buffer);
  tagView.setUint32(0, v.v0l ^ v.v1l ^ v.v2l ^ v.v3l, true);
  tagView.setUint32(4, v.v0h ^ v.v1h ^ v.v2h ^ v.v3h, true);
  return tag;
}

class SipState {
  constructor(
    public v0h: number,
    public v0l: number,
    public v1h: number,
    public v1l: number,
    public v2h: number,
    public v2l: number,
    public v3h: number,
    public v3l: number,
  ) {}

  compress(mh: number, ml: number): void {
    this.v3h = (this.v3h ^ mh) >>> 0;
    this.v3l = (this.v3l ^ ml) >>> 0;
    this.round();
    this.round();
    this.v0h = (this.v0h ^ mh) >>> 0;
    this.v0l = (this.v0l ^ ml) >>> 0;
  }

  round(): void {
    let low: number;
    // v0 += v1; v1 <<<= 13; v1 ^= v0; v0 <<<= 32
    low = (this.v0l + this.v1l) >>> 0;
    this.v0h = (this.v0h + this.v1h + (low < this.v0l ? 1 : 0)) >>> 0;
    this.v0l = low;
    [this.v1h, this.v1l] = rotateLeft(this.v1h, this.v1l, 13);
    this.v1h = (this.v1h ^ this.v0h) >>> 0;
    this.v1l = (this.v1l ^ this.v0l) >>> 0;
    [this.v0h, this.v0l] = [this.v0l, this.v0h];
    // v2 += v3; v3 <<<= 16; v3 ^= v2
    low = (this.v2l + this.v3l) >>> 0;
    this.v2h = (this.v2h + this.v3h + (low < this.v2l ? 1 : 0)) >>> 0;
    this.v2l = low;
    [this.v3h, this.v3l] = rotateLeft(this.v3h, this.v3l, 16);
    this.v3h = (this.v3h ^ this.v2h) >>> 0;
    this.v3l = (this.v3l ^ this.v2l) >>> 0;
    // v0 += v3; v3 <<<= 21; v3 ^= v0
    low = (this.v0l + this.v3l) >>> 0;
    this.v0h = (this.v0h + this.v3h + (low < this.v0l ? 1 : 0)) >>> 0;
    this.v0l = low;
    [this.v3h, this.v3l] = rotateLeft(this.v3h, this.v3l, 21);
    this.v3h = (this.v3h ^ this.v0h) >>> 0;
    this.v3l = (this.v3l ^ this.v0l) >>> 0;
    // v2 += v1; v1 <<<= 17; v1 ^= v2; v2 <<<= 32
    low = (this.v2l + this.v1l) >>> 0;
    this.v2h = (this.v2h + this.v1h + (low < this.v2l ? 1 : 0)) >>> 0;
    this.v2l = low;
    [this.v1h, this.v1l] = rotateLeft(this.v1h, this.v1l, 17);
    this.v1h = (this.v1h ^ this.v2h) >>> 0;
    this.v1l = (this.v1l ^ this.v2l) >>> 0;
    [this.v2h, this.v2l] = [this.v2l, this.v2h];
  }
}

/** Rotates a 64-bit word, given as halves, left by `bits` (below 32). */
function rotateLeft(high: number, low: number, bits: number): [number, number] {
  return [
    ((high << bits) | (low >>> (32 - bits))) >>> 0,
    ((low << bits) | (high >>> (32 - bits))) >>> 0,
  ];
}
