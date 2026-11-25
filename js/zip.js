// Read individual files out of a ZIP stored remotely, using only HTTP range
// requests. Only the central directory and the pages being read are fetched.

const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const u64 = (b, o) => u32(b, o) + u32(b, o + 4) * 0x100000000;

function decodeName(bytes, utf8Flag) {
  if (utf8Flag) return new TextDecoder('utf-8').decode(bytes);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch {}
  try { return new TextDecoder('shift_jis').decode(bytes); } catch {}
  return new TextDecoder('latin1').decode(bytes);
}

// fetchRange(start, endInclusive) -> Promise<Uint8Array>
export async function readDirectory(fetchRange, size) {
  const tailLen = Math.min(size, 65536 + 22 + 1024);
  const tailStart = size - tailLen;
  const tail = await fetchRange(tailStart, size - 1);
  let e = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail[i] === 0x50 && tail[i + 1] === 0x4b && tail[i + 2] === 0x05 && tail[i + 3] === 0x06) { e = i; break; }
  }
  if (e < 0) throw new Error('Not a ZIP file');
  let count = u16(tail, e + 10);
  let cdSize = u32(tail, e + 12);
  let cdOff = u32(tail, e + 16);
  if (cdOff === 0xffffffff || cdSize === 0xffffffff || count === 0xffff) {
    const l = e - 20;
    if (l >= 0 && u32(tail, l) === 0x07064b50) {
      const z64off = u64(tail, l + 8);
      const z = z64off >= tailStart ? tail.subarray(z64off - tailStart) : await fetchRange(z64off, z64off + 55);
      count = u64(z, 32); cdSize = u64(z, 40); cdOff = u64(z, 48);
    }
  }
  const cd = cdOff >= tailStart
    ? tail.subarray(cdOff - tailStart, cdOff - tailStart + cdSize)
    : await fetchRange(cdOff, cdOff + cdSize - 1);

  const entries = [];
  let p = 0;
  while (p + 46 <= cd.length && u32(cd, p) === 0x02014b50) {
    const flags = u16(cd, p + 8);
    const method = u16(cd, p + 10);
    let csize = u32(cd, p + 20);
    let usize = u32(cd, p + 24);
    const nameLen = u16(cd, p + 28);
    const extraLen = u16(cd, p + 30);
    const commentLen = u16(cd, p + 32);
    let offset = u32(cd, p + 42);
    const name = decodeName(cd.subarray(p + 46, p + 46 + nameLen), flags & 0x800);
    // ZIP64 extra field
    let x = p + 46 + nameLen;
    const xEnd = x + extraLen;
    while (x + 4 <= xEnd) {
      const id = u16(cd, x), len = u16(cd, x + 2);
      if (id === 1) {
        let y = x + 4;
        if (usize === 0xffffffff) { usize = u64(cd, y); y += 8; }
        if (csize === 0xffffffff) { csize = u64(cd, y); y += 8; }
        if (offset === 0xffffffff) { offset = u64(cd, y); y += 8; }
      }
      x += 4 + len;
    }
    if (!name.endsWith('/')) {
      entries.push({ name, method, csize, usize, offset, nameLen, extraLen, encrypted: !!(flags & 1) });
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

async function inflateRaw(data) {
  if (typeof DecompressionStream === 'undefined') throw new Error('This browser cannot unzip compressed pages');
  const ds = new DecompressionStream('deflate-raw');
  const stream = new Blob([data]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function readEntry(fetchRange, size, e) {
  if (e.encrypted) throw new Error('Encrypted ZIP entries are not supported');
  const guess = 30 + e.nameLen + e.extraLen + 64;
  const end = Math.min(size - 1, e.offset + guess + e.csize - 1);
  let buf = await fetchRange(e.offset, end);
  if (u32(buf, 0) !== 0x04034b50) throw new Error('Bad ZIP entry');
  const start = 30 + u16(buf, 26) + u16(buf, 28);
  if (buf.length < start + e.csize) {
    const more = await fetchRange(e.offset + buf.length, e.offset + start + e.csize - 1);
    const all = new Uint8Array(buf.length + more.length);
    all.set(buf); all.set(more, buf.length);
    buf = all;
  }
  const data = buf.subarray(start, start + e.csize);
  if (e.method === 0) return data;
  if (e.method === 8) return inflateRaw(data);
  throw new Error('Unsupported ZIP compression method ' + e.method);
}
