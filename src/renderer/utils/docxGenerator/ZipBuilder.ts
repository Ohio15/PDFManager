/**
 * Minimal ZIP file builder using pako for deflate compression.
 * Produces a valid ZIP archive (PKZIP 2.0 compatible) without any external ZIP library.
 *
 * Structure: local file headers + compressed data → central directory → end of central directory record
 */

import pako from 'pako';

interface ZipEntry {
  path: string;
  data: Uint8Array;
  crc32: number;
  compressedData: Uint8Array;
  /** Offset of the local file header in the output */
  localHeaderOffset: number;
}

// Pre-compute CRC-32 lookup table (polynomial 0xEDB88320)
const crcTable: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c;
  }
  return table;
})();

function computeCrc32(data: Uint8Array): number {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < data.length; i++) {
    crc = crcTable[(crc ^ data[i]) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

export class ZipBuilder {
  private entries: ZipEntry[] = [];

  /** Add a file from raw bytes */
  addFile(path: string, data: Uint8Array): void {
    const crc32 = computeCrc32(data);
    // Use raw deflate (no zlib header/trailer) for ZIP DEFLATE method
    const compressedData = pako.deflateRaw(data);
    this.entries.push({
      path,
      data,
      crc32,
      compressedData,
      localHeaderOffset: 0,
    });
  }

  /** Add a file from a UTF-8 string */
  addFileString(path: string, content: string): void {
    const encoder = new TextEncoder();
    this.addFile(path, encoder.encode(content));
  }

  /** Build the complete ZIP file and return as Uint8Array */
  build(): Uint8Array {
    const parts: Uint8Array[] = [];
    let offset = 0;

    // Phase 1: Write local file headers + compressed data
    for (const entry of this.entries) {
      entry.localHeaderOffset = offset;

      const pathBytes = new TextEncoder().encode(entry.path);
      const localHeader = this.buildLocalFileHeader(entry, pathBytes);

      parts.push(localHeader);
      parts.push(entry.compressedData);

      offset += localHeader.length + entry.compressedData.length;
    }

    // Phase 2: Write central directory
    const centralDirStart = offset;
    for (const entry of this.entries) {
      const pathBytes = new TextEncoder().encode(entry.path);
      const centralEntry = this.buildCentralDirectoryEntry(entry, pathBytes);
      parts.push(centralEntry);
      offset += centralEntry.length;
    }
    const centralDirSize = offset - centralDirStart;

    // Phase 3: Write end of central directory record
    const eocd = this.buildEOCD(this.entries.length, centralDirSize, centralDirStart);
    parts.push(eocd);

    // Concatenate all parts
    const totalLength = parts.reduce((sum, p) => sum + p.length, 0);
    const result = new Uint8Array(totalLength);
    let pos = 0;
    for (const part of parts) {
      result.set(part, pos);
      pos += part.length;
    }

    return result;
  }

  private buildLocalFileHeader(entry: ZipEntry, pathBytes: Uint8Array): Uint8Array {
    // Local file header: 30 bytes + path length
    const header = new ArrayBuffer(30 + pathBytes.length);
    const view = new DataView(header);

    view.setUint32(0, 0x04034B50, true);   // Local file header signature
    view.setUint16(4, 20, true);            // Version needed to extract (2.0)
    view.setUint16(6, 0x0800, true);        // General purpose bit flag (bit 11 = UTF-8)
    view.setUint16(8, 8, true);             // Compression method: DEFLATE
    view.setUint16(10, 0, true);            // Last mod file time
    view.setUint16(12, 0, true);            // Last mod file date
    view.setUint32(14, entry.crc32, true);  // CRC-32
    view.setUint32(18, entry.compressedData.length, true);  // Compressed size
    view.setUint32(22, entry.data.length, true);            // Uncompressed size
    view.setUint16(26, pathBytes.length, true);             // File name length
    view.setUint16(28, 0, true);                            // Extra field length

    const result = new Uint8Array(header);
    result.set(pathBytes, 30);
    return result;
  }

  private buildCentralDirectoryEntry(entry: ZipEntry, pathBytes: Uint8Array): Uint8Array {
    // Central directory file header: 46 bytes + path length
    const header = new ArrayBuffer(46 + pathBytes.length);
    const view = new DataView(header);

    view.setUint32(0, 0x02014B50, true);   // Central directory file header signature
    view.setUint16(4, 20, true);            // Version made by (2.0)
    view.setUint16(6, 20, true);            // Version needed to extract (2.0)
    view.setUint16(8, 0x0800, true);        // General purpose bit flag (bit 11 = UTF-8)
    view.setUint16(10, 8, true);            // Compression method: DEFLATE
    view.setUint16(12, 0, true);            // Last mod file time
    view.setUint16(14, 0, true);            // Last mod file date
    view.setUint32(16, entry.crc32, true);  // CRC-32
    view.setUint32(20, entry.compressedData.length, true);  // Compressed size
    view.setUint32(24, entry.data.length, true);            // Uncompressed size
    view.setUint16(28, pathBytes.length, true);             // File name length
    view.setUint16(30, 0, true);            // Extra field length
    view.setUint16(32, 0, true);            // File comment length
    view.setUint16(34, 0, true);            // Disk number start
    view.setUint16(36, 0, true);            // Internal file attributes
    view.setUint32(38, 0, true);            // External file attributes
    view.setUint32(42, entry.localHeaderOffset, true);  // Relative offset of local header

    const result = new Uint8Array(header);
    result.set(pathBytes, 46);
    return result;
  }

  private buildEOCD(entryCount: number, centralDirSize: number, centralDirOffset: number): Uint8Array {
    // End of central directory record: 22 bytes
    const eocd = new ArrayBuffer(22);
    const view = new DataView(eocd);

    view.setUint32(0, 0x06054B50, true);             // EOCD signature
    view.setUint16(4, 0, true);                       // Disk number
    view.setUint16(6, 0, true);                       // Disk with central directory
    view.setUint16(8, entryCount, true);              // Number of entries on this disk
    view.setUint16(10, entryCount, true);             // Total number of entries
    view.setUint32(12, centralDirSize, true);         // Size of central directory
    view.setUint32(16, centralDirOffset, true);       // Offset of central directory
    view.setUint16(20, 0, true);                      // ZIP file comment length

    return new Uint8Array(eocd);
  }
}
