import { basename, extname } from 'path'
import { open, stat } from 'fs/promises'
import { parseSeedFromVideoName } from './videoGalleryMeta'

export interface VideoProbeInfo {
  path: string
  name: string
  sizeBytes: number
  width: number | null
  height: number | null
  codec: string | null
  bitDepth: number | null
  container: string | null
  seed: number | null
}

const FOURCC_CODEC: Record<string, string> = {
  avc1: 'H264',
  avc3: 'H264',
  avcC: 'H264',
  hvc1: 'HEVC',
  hev1: 'HEVC',
  av01: 'AV1',
  vp09: 'VP9',
  vp08: 'VP8',
  mp4v: 'MPEG4'
}

function readU16BE(buf: Buffer, offset: number): number {
  return buf.readUInt16BE(offset)
}

function readU32BE(buf: Buffer, offset: number): number {
  return buf.readUInt32BE(offset)
}

function readFourCC(buf: Buffer, offset: number): string {
  return buf.toString('ascii', offset, offset + 4)
}

function containerFromExt(ext: string): string | null {
  if (ext === '.mp4') return 'MP4'
  if (ext === '.mov') return 'MOV'
  if (ext === '.webm') return 'WebM'
  return ext ? ext.slice(1).toUpperCase() : null
}

function probeAvcC(avcC: Buffer): { bitDepth: number | null } {
  // ISO/IEC 14496-15 AVCDecoderConfigurationRecord
  if (avcC.length < 7) return { bitDepth: null }
  const profile = avcC[1]
  // High 10 / High 10 Intra / High 4:2:2 / High 4:4:4 → typically 10-bit
  if (profile === 110 || profile === 122 || profile === 244) return { bitDepth: 10 }
  return { bitDepth: 8 }
}

function probeHvcC(hvcC: Buffer): { bitDepth: number | null } {
  // ISO/IEC 14496-15 HEVCDecoderConfigurationRecord
  // byte 17: reserved(5) + bitDepthLumaMinus8(3)
  if (hvcC.length < 19) return { bitDepth: null }
  const bitDepthLumaMinus8 = hvcC[17] & 0x07
  const depth = bitDepthLumaMinus8 + 8
  if (depth === 8 || depth === 10 || depth === 12) return { bitDepth: depth }
  return { bitDepth: null }
}

function probeAv1C(av1C: Buffer): { bitDepth: number | null } {
  // AV1CodecConfigurationRecord (aom): marker(1)|version(7), seqProfile(3)|seqLevelIdx0(5),
  // seqTier0|highBitdepth|twelveBit|monochrome|chromaSubX|chromaSubY|chromaSamplePos(2)
  if (av1C.length < 3) return { bitDepth: null }
  const flags = av1C[2]
  const highBitdepth = (flags >> 6) & 1
  const twelveBit = (flags >> 5) & 1
  if (highBitdepth && twelveBit) return { bitDepth: 12 }
  if (highBitdepth) return { bitDepth: 10 }
  return { bitDepth: 8 }
}

type Mp4Probe = {
  width: number | null
  height: number | null
  codec: string | null
  bitDepth: number | null
}

function walkBoxes(
  buf: Buffer,
  start: number,
  end: number,
  onBox: (type: string, payloadStart: number, payloadEnd: number) => void
): void {
  let offset = start
  while (offset + 8 <= end) {
    let size = readU32BE(buf, offset)
    const type = readFourCC(buf, offset + 4)
    let header = 8
    if (size === 1) {
      if (offset + 16 > end) break
      const big = buf.readBigUInt64BE(offset + 8)
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) break
      size = Number(big)
      header = 16
    } else if (size === 0) {
      size = end - offset
    }
    if (size < header || offset + size > end) break
    const payloadStart = offset + header
    const payloadEnd = offset + size
    onBox(type, payloadStart, payloadEnd)
    offset = payloadEnd
  }
}

function probeMp4Buffer(buf: Buffer): Mp4Probe {
  const result: Mp4Probe = {
    width: null,
    height: null,
    codec: null,
    bitDepth: null
  }

  const visitStsd = (payloadStart: number, payloadEnd: number) => {
    if (payloadEnd - payloadStart < 16) return
    // version(1)+flags(3)+entry_count(4)
    const entryCount = readU32BE(buf, payloadStart + 4)
    let entryOffset = payloadStart + 8
    for (let i = 0; i < entryCount && entryOffset + 8 <= payloadEnd; i++) {
      const entrySize = readU32BE(buf, entryOffset)
      const coding = readFourCC(buf, entryOffset + 4)
      if (entrySize < 8 || entryOffset + entrySize > payloadEnd) break

      const mapped = FOURCC_CODEC[coding]
      if (mapped && !result.codec) result.codec = mapped

      // VisualSampleEntry: after SampleEntry(8)+reserved(6)+data_ref(2)+pre_defined… → width/height at +24/+26 from entry start? 
      // SampleEntry = size(4)+type(4)+reserved(6)+data_reference_index(2) = 16
      // VisualSampleEntry adds pre_defined(2)+reserved(2)+pre_defined(12)+width(2)+height(2) → width at entry+32
      if (entryOffset + 36 <= entryOffset + entrySize) {
        const w = readU16BE(buf, entryOffset + 32)
        const h = readU16BE(buf, entryOffset + 34)
        if (w > 0 && h > 0 && !result.width) {
          result.width = w
          result.height = h
        }
      }

      // Nested decoder config boxes inside sample entry
      walkBoxes(buf, entryOffset + 86, entryOffset + entrySize, (ctype, cStart, cEnd) => {
        const slice = buf.subarray(cStart, cEnd)
        if (ctype === 'avcC') {
          if (!result.codec) result.codec = 'H264'
          if (result.bitDepth == null) result.bitDepth = probeAvcC(slice).bitDepth
        } else if (ctype === 'hvcC') {
          if (!result.codec) result.codec = 'HEVC'
          if (result.bitDepth == null) result.bitDepth = probeHvcC(slice).bitDepth
        } else if (ctype === 'av1C') {
          if (!result.codec) result.codec = 'AV1'
          if (result.bitDepth == null) result.bitDepth = probeAv1C(slice).bitDepth
        } else if (ctype === 'vpcC') {
          if (!result.codec) result.codec = 'VP9'
          // vpcC: profile(1)+level(1)+bitDepth(4bits in byte2 high nibble)...
          if (slice.length >= 3 && result.bitDepth == null) {
            const depth = (slice[2] >> 4) & 0x0f
            if (depth === 8 || depth === 10 || depth === 12) result.bitDepth = depth
          }
        }
      })

      // Some files put codec config earlier (after VisualSampleEntry fixed fields = 78 bytes from entry start for many)
      // Also scan whole entry for known config fourccs as fallback
      if (result.bitDepth == null || !result.codec) {
        for (let p = entryOffset + 16; p + 8 <= entryOffset + entrySize; p++) {
          const tag = readFourCC(buf, p + 4)
          if (tag === 'avcC' || tag === 'hvcC' || tag === 'av1C' || tag === 'vpcC') {
            const boxSize = readU32BE(buf, p)
            if (boxSize < 8 || p + boxSize > entryOffset + entrySize) continue
            const slice = buf.subarray(p + 8, p + boxSize)
            if (tag === 'avcC') {
              if (!result.codec) result.codec = 'H264'
              if (result.bitDepth == null) result.bitDepth = probeAvcC(slice).bitDepth
            } else if (tag === 'hvcC') {
              if (!result.codec) result.codec = 'HEVC'
              if (result.bitDepth == null) result.bitDepth = probeHvcC(slice).bitDepth
            } else if (tag === 'av1C') {
              if (!result.codec) result.codec = 'AV1'
              if (result.bitDepth == null) result.bitDepth = probeAv1C(slice).bitDepth
            } else if (tag === 'vpcC') {
              if (!result.codec) result.codec = 'VP9'
              if (slice.length >= 3 && result.bitDepth == null) {
                const depth = (slice[2] >> 4) & 0x0f
                if (depth === 8 || depth === 10 || depth === 12) result.bitDepth = depth
              }
            }
          }
        }
      }

      entryOffset += entrySize
    }
  }

  const visitContainer = (start: number, end: number) => {
    walkBoxes(buf, start, end, (type, payloadStart, payloadEnd) => {
      if (
        type === 'moov' ||
        type === 'trak' ||
        type === 'mdia' ||
        type === 'minf' ||
        type === 'stbl' ||
        type === 'edts'
      ) {
        visitContainer(payloadStart, payloadEnd)
      } else if (type === 'stsd') {
        visitStsd(payloadStart, payloadEnd)
      } else if (type === 'tkhd' && (result.width == null || result.height == null)) {
        // version 0: width/height at +76; version 1: at +88 (16.16 fixed)
        if (payloadEnd - payloadStart >= 4) {
          const version = buf[payloadStart]
          const whOffset = version === 1 ? payloadStart + 88 : payloadStart + 76
          if (whOffset + 8 <= payloadEnd) {
            const w = Math.round(readU32BE(buf, whOffset) / 65536)
            const h = Math.round(readU32BE(buf, whOffset + 4) / 65536)
            if (w > 0 && h > 0) {
              result.width = w
              result.height = h
            }
          }
        }
      }
    })
  }

  visitContainer(0, buf.length)
  if (result.codec && result.bitDepth == null) {
    // Default common case when config lacked depth
    if (result.codec === 'H264') result.bitDepth = 8
  }
  return result
}

function probeWebmBuffer(buf: Buffer): Pick<Mp4Probe, 'codec' | 'bitDepth'> {
  const text = buf.toString('latin1')
  let codec: string | null = null
  if (text.includes('V_AV1')) codec = 'AV1'
  else if (text.includes('V_MPEG4/ISO/AVC')) codec = 'H264'
  else if (text.includes('V_MPEGH/ISO/HEVC')) codec = 'HEVC'
  else if (text.includes('V_VP9')) codec = 'VP9'
  else if (text.includes('V_VP8')) codec = 'VP8'
  return { codec, bitDepth: null }
}

async function readHead(filePath: string, maxBytes: number): Promise<Buffer> {
  const fh = await open(filePath, 'r')
  try {
    const st = await fh.stat()
    const toRead = Math.min(maxBytes, st.size)
    const buf = Buffer.alloc(toRead)
    const { bytesRead } = await fh.read(buf, 0, toRead, 0)
    return buf.subarray(0, bytesRead)
  } finally {
    await fh.close()
  }
}

/** Prefer moov; if moov is at end (common), read more / scan for moov offset via file size. */
async function readMp4ForProbe(filePath: string, fileSize: number): Promise<Buffer> {
  const HEAD = Math.min(fileSize, 8 * 1024 * 1024)
  const head = await readHead(filePath, HEAD)
  // If moov already in head, enough
  if (head.includes(Buffer.from('moov'))) return head

  // Scan top-level boxes in head for moov location; if size says moov is later, read that range
  let offset = 0
  while (offset + 8 <= head.length) {
    let size = readU32BE(head, offset)
    const type = readFourCC(head, offset + 4)
    let header = 8
    if (size === 1 && offset + 16 <= head.length) {
      const big = head.readBigUInt64BE(offset + 8)
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) break
      size = Number(big)
      header = 16
    } else if (size === 0) {
      size = fileSize - offset
    }
    if (size < header) break
    if (type === 'moov') {
      if (offset + size <= head.length) return head
      // moov starts in head but extends past — read full moov region
      const fh = await open(filePath, 'r')
      try {
        const buf = Buffer.alloc(size)
        const { bytesRead } = await fh.read(buf, 0, size, offset)
        return buf.subarray(0, bytesRead)
      } finally {
        await fh.close()
      }
    }
    offset += size
    if (offset > fileSize) break
    // If next box starts beyond what we read, and it's potentially moov, peek
    if (offset + 8 > head.length && offset + 8 <= fileSize) {
      const fh = await open(filePath, 'r')
      try {
        const hdr = Buffer.alloc(16)
        await fh.read(hdr, 0, 16, offset)
        let bsize = readU32BE(hdr, 0)
        const btype = readFourCC(hdr, 4)
        if (bsize === 1) bsize = Number(hdr.readBigUInt64BE(8))
        else if (bsize === 0) bsize = fileSize - offset
        if (btype === 'moov' && bsize > 0 && bsize < 64 * 1024 * 1024) {
          const buf = Buffer.alloc(bsize)
          const { bytesRead } = await fh.read(buf, 0, bsize, offset)
          return buf.subarray(0, bytesRead)
        }
      } finally {
        await fh.close()
      }
      break
    }
  }

  // Fallback: read last 4MB (moov often at end)
  const tailSize = Math.min(fileSize, 4 * 1024 * 1024)
  const fh = await open(filePath, 'r')
  try {
    const buf = Buffer.alloc(tailSize)
    const { bytesRead } = await fh.read(buf, 0, tailSize, Math.max(0, fileSize - tailSize))
    return buf.subarray(0, bytesRead)
  } finally {
    await fh.close()
  }
}

export async function probeVideoFile(filePath: string): Promise<VideoProbeInfo> {
  const name = basename(filePath)
  const ext = extname(filePath).toLowerCase()
  const st = await stat(filePath)
  const info: VideoProbeInfo = {
    path: filePath,
    name,
    sizeBytes: st.size,
    width: null,
    height: null,
    codec: null,
    bitDepth: null,
    container: containerFromExt(ext),
    seed: null
  }

  try {
    info.seed = parseSeedFromVideoName(filePath)
  } catch {
    info.seed = null
  }

  try {
    if (ext === '.mp4' || ext === '.mov') {
      const buf = await readMp4ForProbe(filePath, st.size)
      const parsed = probeMp4Buffer(buf)
      info.width = parsed.width
      info.height = parsed.height
      info.codec = parsed.codec
      info.bitDepth = parsed.bitDepth
    } else if (ext === '.webm') {
      const buf = await readHead(filePath, Math.min(st.size, 2 * 1024 * 1024))
      const parsed = probeWebmBuffer(buf)
      info.codec = parsed.codec
      info.bitDepth = parsed.bitDepth
    }
  } catch {
    /* best-effort metadata */
  }

  return info
}
