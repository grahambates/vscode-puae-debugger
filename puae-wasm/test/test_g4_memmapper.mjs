// src/amigaHunkParser.ts
import { logger } from "@vscode/debugadapter";

// src/amigaMemoryMapper.ts
var MEMF_ANY = 0;
var MEMF_PUBLIC = 1;
var MEMF_CHIP = 2;
var MEMF_FAST = 4;
var MEMF_LOCAL = 256;
var MEMF_24BITDMA = 512;
var MEMF_KICK = 1024;
var NT_MEMORY = 10;
var MemoryClass = /* @__PURE__ */ ((MemoryClass2) => {
  MemoryClass2["CHIP"] = "CHIP";
  MemoryClass2["SLOW"] = "SLOW";
  MemoryClass2["FAST"] = "FAST";
  return MemoryClass2;
})(MemoryClass || {});
function classifyMemory(attributes, lower) {
  if (attributes & MEMF_CHIP) {
    return "CHIP" /* CHIP */;
  }
  if (lower >= 12582912 && lower < 14680064) {
    return "SLOW" /* SLOW */;
  }
  return "FAST" /* FAST */;
}
var AmigaMemoryMapper = class {
  constructor(emulator) {
    this.emulator = emulator;
  }
  /**
   * Get exec.library base pointer from absolute address 0x4
   */
  async getExecBase() {
    return await this.emulator.peek32(4);
  }
  /**
   * Get comprehensive memory information from exec structures
   */
  async getMemoryInfo() {
    const execBase = await this.getExecBase();
    const memListOffset = 322;
    const memListAddr = execBase + memListOffset;
    let totalChip = 0;
    let totalSlow = 0;
    let totalFast = 0;
    let freeChip = 0;
    let freeSlow = 0;
    let freeFast = 0;
    const blocks = [];
    const regions = [];
    let memHeader = await this.emulator.peek32(memListAddr);
    let safetyCounter = 0;
    while (memHeader !== 0 && safetyCounter < 10) {
      if (memHeader > 16777215) {
        break;
      }
      const nodeType = await this.emulator.peek8(memHeader + 8);
      if (nodeType === NT_MEMORY) {
        const attributes = await this.emulator.peek16(memHeader + 14);
        const lower = await this.emulator.peek32(memHeader + 20);
        const upper = await this.emulator.peek32(memHeader + 24);
        const free = await this.emulator.peek32(memHeader + 28);
        const firstChunk = await this.emulator.peek32(memHeader + 16);
        if (lower < upper && lower < 16777216 && upper < 16777216) {
          const regionSize = upper - lower;
          const memClass = classifyMemory(attributes, lower);
          if (memClass === "CHIP" /* CHIP */) {
            totalChip += regionSize;
            freeChip += free;
          } else if (memClass === "SLOW" /* SLOW */) {
            totalSlow += regionSize;
            freeSlow += free;
          } else {
            totalFast += regionSize;
            freeFast += free;
          }
          regions.push({
            lower,
            upper,
            attributes,
            firstChunk
          });
          await this.walkFreeChunks(firstChunk, attributes, blocks);
        }
      }
      memHeader = await this.emulator.peek32(memHeader);
      safetyCounter++;
    }
    this.calculateAllocatedBlocks(regions, blocks);
    return {
      execBase,
      memList: memListAddr,
      totalChip,
      totalSlow,
      totalFast,
      freeChip,
      freeSlow,
      freeFast,
      blocks,
      regions
    };
  }
  /**
   * Walk the free chunk list for a memory header
   */
  async walkFreeChunks(firstChunk, attributes, blocks) {
    let chunk = firstChunk;
    let chunkCount = 0;
    while (chunk !== 0 && chunkCount < 20) {
      const size = await this.emulator.peek32(chunk + 4);
      const nextChunk = await this.emulator.peek32(chunk);
      blocks.push({
        address: chunk,
        size,
        free: true,
        attributes
      });
      chunk = nextChunk;
      chunkCount++;
    }
  }
  /**
   * Calculate allocated blocks by finding gaps between free blocks within each region
   */
  calculateAllocatedBlocks(regions, blocks) {
    for (const region of regions) {
      const freeBlocksInRegion = blocks.filter(
        (b) => b.free && b.address >= region.lower && b.address < region.upper
      ).sort((a, b) => a.address - b.address);
      const allocatedBlocks = [];
      if (freeBlocksInRegion.length > 0) {
        const firstFree = freeBlocksInRegion[0];
        if (firstFree.address > region.lower) {
          allocatedBlocks.push({
            address: region.lower,
            size: firstFree.address - region.lower,
            free: false,
            attributes: region.attributes
          });
        }
      } else {
        allocatedBlocks.push({
          address: region.lower,
          size: region.upper - region.lower,
          free: false,
          attributes: region.attributes
        });
      }
      for (let i = 0; i < freeBlocksInRegion.length - 1; i++) {
        const currentFree = freeBlocksInRegion[i];
        const nextFree = freeBlocksInRegion[i + 1];
        const endOfCurrent = currentFree.address + currentFree.size;
        if (nextFree.address > endOfCurrent) {
          allocatedBlocks.push({
            address: endOfCurrent,
            size: nextFree.address - endOfCurrent,
            free: false,
            attributes: region.attributes
          });
        }
      }
      if (freeBlocksInRegion.length > 0) {
        const lastFree = freeBlocksInRegion[freeBlocksInRegion.length - 1];
        const endOfLast = lastFree.address + lastFree.size;
        if (endOfLast < region.upper) {
          allocatedBlocks.push({
            address: endOfLast,
            size: region.upper - endOfLast,
            free: false,
            attributes: region.attributes
          });
        }
      }
      blocks.push(...allocatedBlocks);
    }
  }
  /**
   * Find a suitable free memory block for allocation
   */
  async findFreeBlock(size, memType) {
    const memInfo = await this.getMemoryInfo();
    if (memType === "CHIP" /* CHIP */) {
      return memInfo.blocks.find(
        (block) => block.free && block.size >= size && block.attributes & MEMF_CHIP
      ) || null;
    } else if (memType === "FAST" /* FAST */) {
      return memInfo.blocks.find(
        (block) => block.free && block.size >= size && block.attributes & MEMF_FAST
      ) || null;
    } else {
      const fastBlock = memInfo.blocks.find(
        (block) => block.free && block.size >= size && block.attributes & MEMF_FAST
      );
      if (fastBlock) {
        return fastBlock;
      }
      return memInfo.blocks.find(
        (block) => block.free && block.size >= size && block.attributes & MEMF_CHIP
      ) || null;
    }
  }
  /**
   * Allocate memory by manipulating exec free chunk lists
   */
  async allocateMemory(size, memType) {
    const alignedSize = size + 3 & ~3;
    const block = await this.findFreeBlock(alignedSize, memType);
    if (!block) {
      throw new Error(
        `No suitable ${memType} memory block found for ${alignedSize} bytes`
      );
    }
    if (block.size === alignedSize) {
      await this.removeFreeChunk(block.address);
      await this.updateMemHeaderFreeCount(block.address, -alignedSize);
    } else {
      const newChunkAddr = block.address + alignedSize;
      const newChunkSize = block.size - alignedSize;
      if (newChunkAddr > 16777215) {
        throw new Error(
          `New chunk address 0x${newChunkAddr.toString(16)} is not a valid 24-bit address`
        );
      }
      const nextChunk = await this.emulator.peek32(block.address);
      await this.emulator.poke32(newChunkAddr, nextChunk);
      await this.emulator.poke32(newChunkAddr + 4, newChunkSize);
      await this.updatePreviousChunkPointer(block.address, newChunkAddr);
      await this.updateMemHeaderFreeCount(block.address, -alignedSize);
    }
    return block.address;
  }
  /**
   * Remove a free chunk from the free list
   */
  async removeFreeChunk(chunkAddr) {
    const nextChunk = await this.emulator.peek32(chunkAddr);
    await this.updatePreviousChunkPointer(chunkAddr, nextChunk);
  }
  /**
   * Update the free byte count in the MemHeader that contains the given address
   */
  async updateMemHeaderFreeCount(address, delta) {
    const execBase = await this.getExecBase();
    const memListAddr = execBase + 322;
    let memHeader = await this.emulator.peek32(memListAddr);
    let safetyCounter = 0;
    while (memHeader !== 0 && safetyCounter < 10) {
      if (memHeader > 16777215) break;
      const nodeType = await this.emulator.peek8(memHeader + 8);
      if (nodeType === NT_MEMORY) {
        const lower = await this.emulator.peek32(memHeader + 20);
        const upper = await this.emulator.peek32(memHeader + 24);
        if (address >= lower && address < upper) {
          const freeAddr = memHeader + 28;
          const currentFree = await this.emulator.peek32(freeAddr);
          const newFree = currentFree + delta;
          await this.emulator.poke32(freeAddr, newFree);
          return;
        }
      }
      memHeader = await this.emulator.peek32(memHeader);
      safetyCounter++;
    }
    throw new Error(
      `Could not find MemHeader for address 0x${address.toString(16)}`
    );
  }
  /**
   * Update the pointer to a chunk in the free list
   */
  async updatePreviousChunkPointer(oldChunk, newChunk) {
    const execBase = await this.getExecBase();
    const memListAddr = execBase + 322;
    let memHeader = await this.emulator.peek32(memListAddr);
    let safetyCounter = 0;
    while (memHeader !== 0 && safetyCounter < 10) {
      if (memHeader > 16777215) break;
      const nodeType = await this.emulator.peek8(memHeader + 8);
      if (nodeType === NT_MEMORY) {
        const firstChunkAddr = memHeader + 16;
        const firstChunk = await this.emulator.peek32(firstChunkAddr);
        if (firstChunk === oldChunk) {
          await this.emulator.poke32(firstChunkAddr, newChunk);
          return;
        }
        let chunk = firstChunk;
        while (chunk !== 0) {
          const nextChunk = await this.emulator.peek32(chunk);
          if (nextChunk === oldChunk) {
            await this.emulator.poke32(chunk, newChunk);
            return;
          }
          chunk = nextChunk;
        }
      }
      memHeader = await this.emulator.peek32(memHeader);
      safetyCounter++;
    }
  }
  /**
   * Free allocated memory back to the OS
   */
  async freeMemory(address, size) {
    const alignedSize = size + 3 & ~3;
    const execBase = await this.getExecBase();
    const memListAddr = execBase + 322;
    let memHeader = await this.emulator.peek32(memListAddr);
    let safetyCounter = 0;
    while (memHeader !== 0 && safetyCounter < 10) {
      if (memHeader > 16777215) break;
      const nodeType = await this.emulator.peek8(memHeader + 8);
      if (nodeType === NT_MEMORY) {
        const lower = await this.emulator.peek32(memHeader + 20);
        const upper = await this.emulator.peek32(memHeader + 24);
        if (address >= lower && address < upper) {
          const firstChunkAddr = memHeader + 16;
          const oldFirstChunk = await this.emulator.peek32(firstChunkAddr);
          await this.emulator.poke32(address, oldFirstChunk);
          await this.emulator.poke32(address + 4, alignedSize);
          await this.emulator.poke32(firstChunkAddr, address);
          const freeAddr = memHeader + 28;
          const currentFree = await this.emulator.peek32(freeAddr);
          await this.emulator.poke32(freeAddr, currentFree + alignedSize);
          return;
        }
      }
      memHeader = await this.emulator.peek32(memHeader);
      safetyCounter++;
    }
    throw new Error(
      `Address ${address.toString(16)} not found in any memory region`
    );
  }
};
export {
  AmigaMemoryMapper,
  MEMF_24BITDMA,
  MEMF_ANY,
  MEMF_CHIP,
  MEMF_FAST,
  MEMF_KICK,
  MEMF_LOCAL,
  MEMF_PUBLIC,
  MemoryClass,
  NT_MEMORY,
  classifyMemory
};
