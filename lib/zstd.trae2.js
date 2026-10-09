/**
 * Multi-frame zstd reading for durable Harness session logs.
 *
 * A session log grows by appending one independently compressed zstd frame per
 * durable write, so the file is a concatenation of frames rather than a single
 * frame. Node's `zstdDecompressSync` and `createZstdDecompress()` both stop at
 * the first frame boundary, so this module walks the frames itself using the
 * zstd frame header layout, decompresses each frame with Node's built-in codec,
 * and concatenates the results.
 *
 * @module @local/dsh-trae-session-vault/zstd
 */
import zlib from 'node:zlib';

/** Standard zstd frame magic, little-endian `0xFD2FB528`. */
const ZSTD_MAGIC = 0xfd2fb528;
/** Skippable frame magic mask: the low nibble of the magic is free. */
const SKIPPABLE_MASK = 0xfffffff0;
const SKIPPABLE_MAGIC = 0x184d2a50;

/**
 * Whether this Node build exposes the synchronous zstd codec. Node 22.15+/23.8+
 * do; when it is missing the caller degrades to a readable message instead of
 * throwing during plugin activation.
 * @returns {boolean} true when zstd decompression is available.
 */
export function hasZstd() {
  return typeof zlib.zstdDecompressSync === 'function';
}

/**
 * Measure one complete frame starting at `pos`.
 * @param {Buffer} buffer - the whole file or a window of it.
 * @param {number} pos - offset of the frame's first byte.
 * @returns {number} the frame length in bytes, or `-1` when the frame is incomplete.
 * @throws {Error} when the bytes cannot be a zstd frame at all.
 */
function frameLength(buffer, pos) {
  if (buffer.length - pos < 5) return -1;
  const magic = buffer.readUInt32LE(pos);
  if ((magic & SKIPPABLE_MASK) === SKIPPABLE_MAGIC) {
    if (buffer.length - pos < 8) return -1;
    const payload = buffer.readUInt32LE(pos + 4);
    const total = 8 + payload;
    return buffer.length - pos < total ? -1 : total;
  }
  if (magic !== ZSTD_MAGIC) {
    throw new Error(`not a zstd frame at byte ${pos} (magic 0x${magic.toString(16)})`);
  }
  const descriptor = buffer[pos + 4];
  const contentSizeFlag = (descriptor >> 6) & 3;
  const singleSegment = (descriptor >> 5) & 1;
  const checksum = (descriptor >> 2) & 1;
  const dictionaryIdFlag = descriptor & 3;

  let cursor = pos + 5;
  if (singleSegment === 0) cursor += 1; // Window_Descriptor
  if (dictionaryIdFlag !== 0) cursor += 1 << dictionaryIdFlag;
  const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment === 1 ? 1 : 0)
    : contentSizeFlag === 1 ? 2 : contentSizeFlag === 2 ? 4 : 8;
  cursor += contentSizeBytes;

  for (;;) {
    if (buffer.length - cursor < 3) return -1;
    const header = buffer[cursor] | (buffer[cursor + 1] << 8) | (buffer[cursor + 2] << 16);
    const last = header & 1;
    const blockType = (header >> 1) & 3;
    const blockSize = header >> 3;
    cursor += 3;
    if (blockType === 0) cursor += blockSize; // Raw_Block
    else if (blockType === 1) cursor += 1; // RLE_Block
    else if (blockType === 2) cursor += blockSize; // Compressed_Block
    else throw new Error(`reserved zstd block type at byte ${cursor - 3}`);
    if (last === 1) break;
  }
  if (checksum === 1) cursor += 4;
  return cursor - pos;
}

/**
 * Decompress every complete zstd frame in `buffer`, in file order.
 *
 * A frame that is still being written is reported through `skippedBytes` rather
 * than thrown, so a live session's tail never loses the frames already durable.
 * Frames that fail to decode are counted in `failedFrames` and do not abort the
 * read of their neighbours.
 *
 * @param {Buffer} buffer - raw file bytes.
 * @returns {{ text: string, frames: number, failedFrames: number, skippedBytes: number, error?: string }}
 *   the concatenated decoded text plus a summary of what was consumed.
 */
export function decodeZstdFrames(buffer) {
  if (!hasZstd()) {
    return {
      text: '',
      frames: 0,
      failedFrames: 0,
      skippedBytes: buffer.length,
      error: 'this Node runtime has no zstd codec (zlib.zstdDecompressSync is unavailable)',
    };
  }
  const chunks = [];
  let pos = 0;
  let frames = 0;
  let failedFrames = 0;
  let skippedBytes = 0;
  while (pos < buffer.length) {
    let length;
    try {
      length = frameLength(buffer, pos);
    } catch (error) {
      return {
        text: Buffer.concat(chunks).toString('utf8'),
        frames,
        failedFrames,
        skippedBytes: buffer.length - pos,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    if (length < 0) {
      skippedBytes = buffer.length - pos;
      break;
    }
    try {
      chunks.push(zlib.zstdDecompressSync(buffer.subarray(pos, pos + length)));
      frames += 1;
    } catch {
      failedFrames += 1;
    }
    pos += length;
  }
  return { text: Buffer.concat(chunks).toString('utf8'), frames, failedFrames, skippedBytes };
}
