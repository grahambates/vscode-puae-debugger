// src/amigaHunkParser.ts
import { logger } from "@vscode/debugadapter";

// src/amigaMemoryMapper.ts
var MEMF_CHIP = 2;
var MEMF_FAST = 4;
var NT_MEMORY = 10;
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

// src/amigaHunkLoader.ts
var AmigaHunkLoader = class _AmigaHunkLoader {
  constructor(emulator) {
    this.emulator = emulator;
    this.memoryMapper = new AmigaMemoryMapper(emulator);
  }
  memoryMapper;
  /**
   * Load hunks into memory with OS-aware allocation
   */
  async loadProgram(hunks) {
    if (hunks.length === 0) {
      throw new Error("Program loading error: No hunks to load");
    }
    const allocations = await this.allocateHunks(hunks);
    await this.writeHunkData(allocations);
    await this.applyRelocations(hunks, allocations);
    const totalSize = allocations.reduce((sum, alloc) => sum + alloc.size, 0);
    const codeHunk = allocations.find(
      (alloc) => alloc.hunk.hunkType === "CODE" /* CODE */
    );
    const entryPoint = codeHunk?.address || allocations[0]?.address || 0;
    return {
      entryPoint,
      allocations,
      totalSize
    };
  }
  /**
   * Allocate memory for all hunks using OS allocation
   */
  async allocateHunks(hunks) {
    const allocations = [];
    for (const hunk of hunks) {
      console.log(
        `Allocating ${hunk.allocSize} bytes of ${hunk.memType} memory for hunk ${hunk.index}`
      );
      const address = await this.memoryMapper.allocateMemory(
        hunk.allocSize,
        hunk.memType
      );
      allocations.push({
        hunk,
        address,
        size: hunk.allocSize
      });
      console.log(
        `Hunk ${hunk.index} allocated at address $${address.toString(16)}`
      );
    }
    return allocations;
  }
  /**
   * Apply relocations to resolve inter-hunk references
   */
  async applyRelocations(hunks, allocations) {
    const hunkAddresses = /* @__PURE__ */ new Map();
    for (const alloc of allocations) {
      hunkAddresses.set(alloc.hunk.index, alloc.address);
    }
    for (const alloc of allocations) {
      const hunk = alloc.hunk;
      if (hunk.reloc32.length > 0) {
        console.log(
          `Applying ${hunk.reloc32.length} relocation groups for hunk ${hunk.index}`
        );
        for (const relocInfo of hunk.reloc32) {
          const targetAddress = hunkAddresses.get(relocInfo.target);
          if (targetAddress === void 0) {
            throw new Error(
              `Program loading error: Relocation target hunk ${relocInfo.target} not found`
            );
          }
          await this.applyRelocationGroup(alloc, relocInfo, targetAddress);
        }
      }
    }
  }
  /**
   * Apply a group of relocations for a specific target hunk
   */
  async applyRelocationGroup(alloc, relocInfo, targetAddress) {
    for (const offset of relocInfo.offsets) {
      const relocAddress = alloc.address + offset;
      const currentValue = await this.emulator.peek32(relocAddress);
      const relocatedValue = currentValue + targetAddress;
      await this.emulator.poke32(relocAddress, relocatedValue);
      console.log(
        `Relocation at $${relocAddress.toString(16)}: $${currentValue.toString(16)} + $${targetAddress.toString(16)} = $${relocatedValue.toString(16)}`
      );
    }
  }
  /**
   * Write hunk data to allocated memory locations
   */
  async writeHunkData(allocations) {
    for (const alloc of allocations) {
      const hunk = alloc.hunk;
      if (hunk.hunkType === "BSS" /* BSS */) {
        console.log(
          `Zeroing BSS hunk ${hunk.index} at $${alloc.address.toString(16)}`
        );
        await this.zeroMemory(alloc.address, alloc.size);
      } else if (hunk.data) {
        console.log(
          `Writing ${hunk.data.length} bytes for ${hunk.hunkType} hunk ${hunk.index} at $${alloc.address.toString(16)}`
        );
        await this.emulator.writeMemory(alloc.address, hunk.data);
      }
    }
  }
  /**
   * Zero out a memory region (for BSS hunks)
   */
  async zeroMemory(address, size) {
    const zeroBuffer = Buffer.alloc(size);
    await this.emulator.writeMemory(address, zeroBuffer);
  }
  /**
   * Free all allocated memory when program is unloaded
   */
  async unloadProgram(program) {
    console.log(`Unloading program with ${program.allocations.length} hunks`);
    for (const alloc of program.allocations) {
      console.log(
        `Freeing hunk ${alloc.hunk.index} at $${alloc.address.toString(16)}`
      );
      await this.memoryMapper.freeMemory(alloc.address, alloc.size);
    }
  }
  /**
   * Get memory allocation statistics
   */
  async getMemoryStats() {
    return await this.memoryMapper.getMemoryInfo();
  }
  /**
   * Load and relocate hunks from binary data
   */
  static async loadFromHunks(emulator, hunks) {
    const loader = new _AmigaHunkLoader(emulator);
    return await loader.loadProgram(hunks);
  }
  /**
   * Create a program entry point setup
   * Sets up registers and jumps to program start
   */
  async setupProgramEntry(program) {
    await this.setupReturnTrampoline();
    await this.clearInterruptMask();
    await this.emulator.jump(program.entryPoint);
    console.log(
      `Program entry point set to $${program.entryPoint.toString(16)}`
    );
  }
  /**
   * fastLoad injects the program at whatever point Kickstart's boot sequence
   * happened to be paused, inheriting its SR - including the CPU interrupt
   * priority mask (SR bits 8-10). If that mask is non-zero, the 68000 itself
   * blocks any interrupt at or below that level (VERTB/Copper/Blitter are
   * level 3, CIA-A PORTS is level 2) regardless of INTENA/INTREQ, so programs
   * relying on those interrupts for their main loop never wake up. Clear the
   * mask so the program starts with all interrupt levels enabled, matching a
   * normal AmigaDOS program launch.
   */
  async clearInterruptMask() {
    const cpuInfo = await this.emulator.getCpuInfo();
    const sr = Number(cpuInfo.sr) & ~0x0700;
    await this.emulator.setRegister("sr", sr);
  }
  /**
   * fastLoad injects the program directly with no DOS process to return to,
   * so an `rts` at the end of the program would pop a garbage return address
   * and crash the emulator. Instead, build a synthetic call frame at the top
   * of the *currently active* stack: a return address pointing at a small
   * landing-pad routine that shuts down DMA and interrupts and then spins
   * forever - mimicking what a real `jsr` into the program would have left
   * behind, so `rts` lands somewhere harmless when the program exits.
   *
   * "Currently active stack" means A7 as reported by getCpuInfo(), which is
   * the live stack pointer regardless of CPU mode - USP while in user mode,
   * SSP while in supervisor mode. `rts` always pops from A7, so building the
   * frame there (rather than the dormant USP shadow register when the CPU is
   * in supervisor mode) is what actually makes the landing pad reachable.
   */
  async setupReturnTrampoline() {
    const TRAMPOLINE_CODE = Buffer.from([
      51,
      252,
      127,
      255,
      0,
      223,
      240,
      150,
      51,
      252,
      127,
      255,
      0,
      223,
      240,
      154,
      96,
      254
    ]);
    const cpuInfo = await this.emulator.getCpuInfo();
    const sp = Number(cpuInfo.a7);
    const trampolineAddress = sp - TRAMPOLINE_CODE.length;
    const returnAddress = trampolineAddress - 4;
    await this.emulator.writeMemory(trampolineAddress, TRAMPOLINE_CODE);
    await this.emulator.poke32(returnAddress, trampolineAddress);
    await this.emulator.setRegister("a7", returnAddress);
    console.log(
      `Set up return trampoline at $${trampolineAddress.toString(16)}, a7=$${returnAddress.toString(16)}`
    );
  }
};
async function loadAmigaProgram(emulator, hunks) {
  console.log(`Loading Amiga program with ${hunks.length} hunks`);
  const loader = new AmigaHunkLoader(emulator);
  const program = await loader.loadProgram(hunks);
  await loader.setupProgramEntry(program);
  return program;
}
export {
  AmigaHunkLoader,
  loadAmigaProgram
};
