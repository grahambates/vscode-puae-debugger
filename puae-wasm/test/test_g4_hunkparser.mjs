// src/amigaHunkParser.ts
import { logger } from "@vscode/debugadapter";
import { readFile } from "fs/promises";
var HunkType = /* @__PURE__ */ ((HunkType2) => {
  HunkType2["CODE"] = "CODE";
  HunkType2["DATA"] = "DATA";
  HunkType2["BSS"] = "BSS";
  return HunkType2;
})(HunkType || {});
var MemoryType = /* @__PURE__ */ ((MemoryType2) => {
  MemoryType2["ANY"] = "ANY";
  MemoryType2["CHIP"] = "CHIP";
  MemoryType2["FAST"] = "FAST";
  return MemoryType2;
})(MemoryType || {});
var BlockTypes = {
  CODE: 1001,
  DATA: 1002,
  BSS: 1003,
  RELOC32: 1004,
  SYMBOL: 1008,
  DEBUG: 1009,
  END: 1010,
  HEADER: 1011,
  DREL32: 1015,
  DREL16: 1016,
  DREL8: 1017
};
async function parseHunksFromFile(filename) {
  const buffer = await readFile(filename);
  return parseHunks(buffer);
}
function parseHunks(contents) {
  const reader = new BufferReader(contents);
  const type = reader.readLong();
  if (type !== BlockTypes.HEADER) {
    throw new Error(
      `Invalid hunk file: Expected HUNK_HEADER (0x${BlockTypes.HEADER.toString(16)}) but got 0x${type.toString(16)}`
    );
  }
  return parseHeader(reader).map(
    (hunkInfo, index) => createHunk(hunkInfo, index, reader)
  );
}
function parseHeader(reader) {
  reader.skip(4);
  const tableSize = reader.readLong();
  const firstHunk = reader.readLong();
  const lastHunk = reader.readLong();
  if (tableSize < 0 || firstHunk < 0 || lastHunk < 0) {
    throw new Error("Invalid hunk file: Hunk size table is invalid");
  }
  const hunkTable = [];
  const hunkCount = lastHunk - firstHunk + 1;
  for (let i = 0; i < hunkCount; i++) {
    const hunkSize = reader.readLong();
    let memType = "ANY" /* ANY */;
    const masked = hunkSize & 4026531840;
    if (masked === 1 << 30) {
      memType = "CHIP" /* CHIP */;
    } else if (masked === 1 << 31) {
      memType = "FAST" /* FAST */;
    }
    hunkTable.push({
      memType,
      allocSize: (hunkSize & 268435455) * 4
      // Mask upper bytes containing memory type
    });
  }
  return hunkTable;
}
function createHunk({ memType, allocSize }, index, reader) {
  const hunk = {
    index,
    fileOffset: reader.offset(),
    memType,
    hunkType: "CODE" /* CODE */,
    // Placeholder for valid type
    allocSize,
    symbols: [],
    reloc32: [],
    lineDebugInfo: []
  };
  let blockType = reader.readLong();
  while (blockType !== BlockTypes.END) {
    switch (blockType) {
      // Initial hunk blocks:
      // These define the type and content of the hunk
      case BlockTypes.CODE:
        hunk.hunkType = "CODE" /* CODE */;
        hunk.dataSize = reader.readLong() * 4;
        hunk.dataOffset = reader.offset();
        hunk.data = reader.readBytes(hunk.dataSize);
        break;
      case BlockTypes.DATA:
        hunk.hunkType = "DATA" /* DATA */;
        hunk.dataSize = reader.readLong() * 4;
        hunk.dataOffset = reader.offset();
        hunk.data = reader.readBytes(hunk.dataSize);
        break;
      case BlockTypes.BSS:
        hunk.hunkType = "BSS" /* BSS */;
        hunk.allocSize = reader.readLong() * 4;
        break;
      // Additional hunk blocks:
      // These provide additional properties
      case BlockTypes.DEBUG: {
        const info = parseDebug(reader);
        if (info) {
          hunk.lineDebugInfo.push(info);
        }
        break;
      }
      case BlockTypes.RELOC32:
        hunk.reloc32.push(...parseReloc32(reader));
        break;
      case BlockTypes.DREL32:
        hunk.reloc32.push(...parseDrel32(reader));
        break;
      case BlockTypes.DREL16:
        parseDrel16(reader);
        break;
      case BlockTypes.DREL8:
        parseDrel8(reader);
        break;
      case BlockTypes.SYMBOL:
        hunk.symbols.push(...parseSymbols(reader));
        break;
      // Skip all other block types
      default:
        logger.error(
          "Skipping unsupported hunk type: " + blockType.toString(16)
        );
        reader.skip(reader.readLong() * 4);
        break;
    }
    if (reader.finished()) {
      break;
    }
    blockType = reader.readLong();
  }
  return hunk;
}
function parseSymbols(reader) {
  const symbols = [];
  let numLongs = reader.readLong();
  while (numLongs > 0) {
    symbols.push({
      name: reader.readString(numLongs * 4),
      offset: reader.readLong()
    });
    numLongs = reader.readLong();
  }
  if (symbols.length > 0) {
    symbols.sort(function(a, b) {
      return a.offset > b.offset ? 1 : b.offset > a.offset ? -1 : 0;
    });
  }
  return symbols;
}
function parseDebug(reader) {
  const numLongs = reader.readLong();
  const baseOffset = reader.readLong();
  const debugTag = reader.readString(4);
  if (debugTag !== "LINE") {
    reader.skip((numLongs - 2) * 4);
    return null;
  }
  const numNameLongs = reader.readLong();
  const sourceFilename = reader.readString(numNameLongs * 4);
  const numLines = (numLongs - numNameLongs - 3) / 2;
  const lines = [];
  for (let i = 0; i < numLines; i++) {
    lines.push({
      line: reader.readLong() & 16777215,
      // mask for SAS/C extra info
      offset: baseOffset + reader.readLong()
    });
  }
  return { sourceFilename, lines, baseOffset };
}
function parseReloc32(reader) {
  const relocs = [];
  let count = reader.readLong();
  while (count !== 0) {
    const target = reader.readLong();
    const offsets = [];
    for (let i = 0; i < count; i++) {
      offsets.push(reader.readLong());
    }
    relocs.push({ target, offsets });
    count = reader.readLong();
  }
  return relocs;
}
function parseDrel32(reader) {
  const relocs = [];
  let wordCount = 0;
  let count = reader.readWord();
  wordCount++;
  while (count !== 0) {
    const target = reader.readWord();
    wordCount++;
    const offsets = [];
    for (let i = 0; i < count; i++) {
      offsets.push(reader.readWord());
      wordCount++;
    }
    relocs.push({ target, offsets });
    count = reader.readWord();
    wordCount++;
  }
  if (wordCount % 2 === 1) {
    reader.skip(2);
  }
  return relocs;
}
function parseDrel16(reader) {
  let wordCount = 0;
  let count = reader.readWord();
  wordCount++;
  while (count !== 0) {
    reader.readWord();
    wordCount++;
    for (let i = 0; i < count; i++) {
      reader.readWord();
      wordCount++;
    }
    count = reader.readWord();
    wordCount++;
  }
  if (wordCount % 2 === 1) {
    reader.skip(2);
  }
}
function parseDrel8(reader) {
  let wordCount = 0;
  let count = reader.readWord();
  wordCount++;
  while (count !== 0) {
    reader.readWord();
    wordCount++;
    for (let i = 0; i < count; i++) {
      reader.readWord();
      wordCount++;
    }
    count = reader.readWord();
    wordCount++;
  }
  if (wordCount % 2 === 1) {
    reader.skip(2);
  }
}
var BufferReader = class {
  constructor(buffer) {
    this.buffer = buffer;
  }
  pos = 0;
  readLong() {
    if (this.pos + 4 > this.buffer.length) {
      throw new Error(
        `Buffer overrun: trying to read 4 bytes at position ${this.pos}, buffer length is ${this.buffer.length}`
      );
    }
    const value = this.buffer.readUInt32BE(this.pos);
    this.pos += 4;
    return value;
  }
  readWord() {
    if (this.pos + 2 > this.buffer.length) {
      throw new Error(
        `Buffer overrun: trying to read 2 bytes at position ${this.pos}, buffer length is ${this.buffer.length}`
      );
    }
    const value = this.buffer.readUInt16BE(this.pos);
    this.pos += 2;
    return value;
  }
  readByte() {
    if (this.pos >= this.buffer.length) {
      throw new Error(
        `Buffer overrun: trying to read 1 byte at position ${this.pos}, buffer length is ${this.buffer.length}`
      );
    }
    return this.buffer.readUInt8(this.pos++);
  }
  readBytes(length) {
    if (this.pos + length > this.buffer.length) {
      throw new Error(
        `Buffer overrun: trying to read ${length} bytes at position ${this.pos}, buffer length is ${this.buffer.length}`
      );
    }
    const slice = this.buffer.slice(this.pos, this.pos + length);
    this.pos += length;
    return slice;
  }
  readString(length) {
    const startPos = this.pos;
    const charCodes = [];
    for (let i = 0; i < length; i++) {
      const v = this.readByte();
      if (v === 0) {
        break;
      }
      charCodes.push(v);
    }
    this.pos = startPos + length;
    return String.fromCharCode(...charCodes);
  }
  skip(bytes) {
    this.pos += bytes;
  }
  finished() {
    return this.pos >= this.buffer.length;
  }
  canRead(bytes) {
    return this.pos + bytes <= this.buffer.length;
  }
  offset() {
    return this.pos;
  }
};
export {
  HunkType,
  MemoryType,
  parseHunks,
  parseHunksFromFile
};
