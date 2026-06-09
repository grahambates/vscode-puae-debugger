/**
 * Amiga OS-aware memory manager for direct program injection
 * Interfaces with exec.library memory management structures
 */

import { Emulator } from "./emulator";
import { Hunk, MemoryType } from "./amigaHunkParser";

export interface SegmentInfo {
  name: string;
  address: number;
}

export interface MemoryBlock {
  address: number;
  size: number;
  free: boolean;
  attributes: number;
  segmentName?: string;
  segments?: SegmentInfo[];
}

export interface MemoryRegion {
  lower: number;
  upper: number;
  attributes: number;
  firstChunk: number;
}

export interface ExecMemoryInfo {
  execBase: number;
  memList: number;
  totalChip: number;
  totalSlow: number;
  totalFast: number;
  freeChip: number;
  freeSlow: number;
  freeFast: number;
  blocks: MemoryBlock[];
  regions: MemoryRegion[];
}

export interface AllocatedHunk {
  hunk: Hunk;
  address: number;
  size: number;
}

export interface LoadedProgram {
  entryPoint: number;
  allocations: AllocatedHunk[];
  totalSize: number;
}

// Amiga memory attributes
export const MEMF_ANY = 0x00000000;
export const MEMF_PUBLIC = 0x00000001;
export const MEMF_CHIP = 0x00000002;
export const MEMF_FAST = 0x00000004;
export const MEMF_LOCAL = 0x00000100;
export const MEMF_24BITDMA = 0x00000200;
export const MEMF_KICK = 0x00000400;

// Node types
export const NT_MEMORY = 10;

// Memory type classification
export enum MemoryClass {
  CHIP = "CHIP",
  SLOW = "SLOW",
  FAST = "FAST",
}

/**
 * Classify memory region based on attributes and address
 * Slow RAM is typically in the 0xC00000-0xDFFFFF range (A500 trapdoor expansion)
 */
export function classifyMemory(attributes: number, lower: number): MemoryClass {
  if (attributes & MEMF_CHIP) {
    return MemoryClass.CHIP;
  }
  // Slow RAM is typically in the ranger memory space (0xC00000-0xDFFFFF)
  if (lower >= 0xc00000 && lower < 0xe00000) {
    return MemoryClass.SLOW;
  }
  return MemoryClass.FAST;
}

export class AmigaMemoryMapper {
  constructor(private vAmiga: Emulator) {}

  /**
   * Get exec.library base pointer from absolute address 0x4
   */
  async getExecBase(): Promise<number> {
    return await this.vAmiga.peek32(0x4);
  }

  /**
   * Get comprehensive memory information from exec structures
   */
  async getMemoryInfo(): Promise<ExecMemoryInfo> {
    const execBase = await this.getExecBase();

    // ExecBase structure offsets according to AmigaOS documentation
    const memListOffset = 0x142; // List of MemHeader structures
    const memListAddr = execBase + memListOffset;

    let totalChip = 0;
    let totalSlow = 0;
    let totalFast = 0;
    let freeChip = 0;
    let freeSlow = 0;
    let freeFast = 0;
    const blocks: MemoryBlock[] = [];
    const regions: MemoryRegion[] = [];

    // Walk the memory header list
    let memHeader = await this.vAmiga.peek32(memListAddr);

    let safetyCounter = 0;
    while (memHeader !== 0 && safetyCounter < 10) {
      // Validate memHeader address is reasonable
      if (memHeader > 0xffffff) {
        break;
      }

      const nodeType = await this.vAmiga.peek8(memHeader + 0x08);

      if (nodeType === NT_MEMORY) {
        const attributes = await this.vAmiga.peek16(memHeader + 0x0e);
        const lower = await this.vAmiga.peek32(memHeader + 0x14);
        const upper = await this.vAmiga.peek32(memHeader + 0x18);
        const free = await this.vAmiga.peek32(memHeader + 0x1c);
        const firstChunk = await this.vAmiga.peek32(memHeader + 0x10);

        // Validate memory region makes sense
        if (lower < upper && lower < 0x1000000 && upper < 0x1000000) {
          const regionSize = upper - lower;
          const memClass = classifyMemory(attributes, lower);

          if (memClass === MemoryClass.CHIP) {
            totalChip += regionSize;
            freeChip += free;
          } else if (memClass === MemoryClass.SLOW) {
            totalSlow += regionSize;
            freeSlow += free;
          } else {
            totalFast += regionSize;
            freeFast += free;
          }

          // Store region info
          regions.push({
            lower,
            upper,
            attributes,
            firstChunk,
          });

          // Walk free chunks in this memory header
          await this.walkFreeChunks(firstChunk, attributes, blocks);
        }
      }

      // Next memory header - read ln_Succ (first field of Node structure)
      memHeader = await this.vAmiga.peek32(memHeader);
      safetyCounter++;
    }

    // Calculate allocated blocks by finding gaps between free blocks
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
      regions,
    };
  }

  /**
   * Walk the free chunk list for a memory header
   */
  private async walkFreeChunks(
    firstChunk: number,
    attributes: number,
    blocks: MemoryBlock[],
  ): Promise<void> {
    let chunk = firstChunk;
    let chunkCount = 0;

    while (chunk !== 0 && chunkCount < 20) {
      // Safety limit
      const size = await this.vAmiga.peek32(chunk + 0x04);
      const nextChunk = await this.vAmiga.peek32(chunk);

      blocks.push({
        address: chunk,
        size,
        free: true,
        attributes,
      });

      chunk = nextChunk;
      chunkCount++;
    }
  }

  /**
   * Calculate allocated blocks by finding gaps between free blocks within each region
   */
  private calculateAllocatedBlocks(
    regions: MemoryRegion[],
    blocks: MemoryBlock[],
  ): void {
    for (const region of regions) {
      // Get all free blocks in this region and sort by address
      const freeBlocksInRegion = blocks
        .filter(
          (b) => b.free && b.address >= region.lower && b.address < region.upper,
        )
        .sort((a, b) => a.address - b.address);

      // Track allocated regions between free blocks
      const allocatedBlocks: MemoryBlock[] = [];

      // Check if there's allocated space before the first free block
      if (freeBlocksInRegion.length > 0) {
        const firstFree = freeBlocksInRegion[0];
        if (firstFree.address > region.lower) {
          allocatedBlocks.push({
            address: region.lower,
            size: firstFree.address - region.lower,
            free: false,
            attributes: region.attributes,
          });
        }
      } else {
        // No free blocks means entire region is allocated
        allocatedBlocks.push({
          address: region.lower,
          size: region.upper - region.lower,
          free: false,
          attributes: region.attributes,
        });
      }

      // Find gaps between consecutive free blocks
      for (let i = 0; i < freeBlocksInRegion.length - 1; i++) {
        const currentFree = freeBlocksInRegion[i];
        const nextFree = freeBlocksInRegion[i + 1];
        const endOfCurrent = currentFree.address + currentFree.size;

        if (nextFree.address > endOfCurrent) {
          // There's a gap - this is allocated memory
          allocatedBlocks.push({
            address: endOfCurrent,
            size: nextFree.address - endOfCurrent,
            free: false,
            attributes: region.attributes,
          });
        }
      }

      // Check if there's allocated space after the last free block
      if (freeBlocksInRegion.length > 0) {
        const lastFree = freeBlocksInRegion[freeBlocksInRegion.length - 1];
        const endOfLast = lastFree.address + lastFree.size;
        if (endOfLast < region.upper) {
          allocatedBlocks.push({
            address: endOfLast,
            size: region.upper - endOfLast,
            free: false,
            attributes: region.attributes,
          });
        }
      }

      // Add allocated blocks to the main blocks array
      blocks.push(...allocatedBlocks);
    }
  }

  /**
   * Find a suitable free memory block for allocation
   */
  async findFreeBlock(
    size: number,
    memType: MemoryType,
  ): Promise<MemoryBlock | null> {
    const memInfo = await this.getMemoryInfo();

    if (memType === MemoryType.CHIP) {
      // CHIP memory specifically requested
      return (
        memInfo.blocks.find(
          (block) =>
            block.free && block.size >= size && block.attributes & MEMF_CHIP,
        ) || null
      );
    } else if (memType === MemoryType.FAST) {
      // FAST memory specifically requested
      return (
        memInfo.blocks.find(
          (block) =>
            block.free && block.size >= size && block.attributes & MEMF_FAST,
        ) || null
      );
    } else {
      // MEMF_ANY - prefer FAST RAM over CHIP RAM to preserve chip memory

      // First try to find fast RAM
      const fastBlock = memInfo.blocks.find(
        (block) =>
          block.free && block.size >= size && block.attributes & MEMF_FAST,
      );

      if (fastBlock) {
        return fastBlock;
      }

      // Fall back to chip RAM if no fast RAM available
      return (
        memInfo.blocks.find(
          (block) =>
            block.free && block.size >= size && block.attributes & MEMF_CHIP,
        ) || null
      );
    }
  }

  /**
   * Allocate memory by manipulating exec free chunk lists
   */
  async allocateMemory(size: number, memType: MemoryType): Promise<number> {
    // Round size up to longword boundary
    const alignedSize = (size + 3) & ~3;

    const block = await this.findFreeBlock(alignedSize, memType);
    if (!block) {
      throw new Error(
        `No suitable ${memType} memory block found for ${alignedSize} bytes`,
      );
    }

    // If block is exactly the right size, remove it entirely
    if (block.size === alignedSize) {
      await this.removeFreeChunk(block.address);
      // Update the MemHeader free count
      await this.updateMemHeaderFreeCount(block.address, -alignedSize);
    } else {
      // Split the block - create new free chunk for remainder
      const newChunkAddr = block.address + alignedSize;
      const newChunkSize = block.size - alignedSize;

      // Validate new chunk address is reasonable
      if (newChunkAddr > 0xffffff) {
        throw new Error(
          `New chunk address 0x${newChunkAddr.toString(16)} is not a valid 24-bit address`,
        );
      }

      // Get next chunk pointer from original
      const nextChunk = await this.vAmiga.peek32(block.address);

      // Set up new chunk header
      await this.vAmiga.poke32(newChunkAddr, nextChunk); // next pointer
      await this.vAmiga.poke32(newChunkAddr + 0x04, newChunkSize); // size

      // Update previous chunk to point to new chunk
      await this.updatePreviousChunkPointer(block.address, newChunkAddr);

      // Update the MemHeader free count
      await this.updateMemHeaderFreeCount(block.address, -alignedSize);
    }

    return block.address;
  }

  /**
   * Remove a free chunk from the free list
   */
  private async removeFreeChunk(chunkAddr: number): Promise<void> {
    const nextChunk = await this.vAmiga.peek32(chunkAddr);
    await this.updatePreviousChunkPointer(chunkAddr, nextChunk);
  }

  /**
   * Update the free byte count in the MemHeader that contains the given address
   */
  private async updateMemHeaderFreeCount(
    address: number,
    delta: number,
  ): Promise<void> {
    const execBase = await this.getExecBase();
    const memListAddr = execBase + 0x142;

    let memHeader = await this.vAmiga.peek32(memListAddr);

    let safetyCounter = 0;
    while (memHeader !== 0 && safetyCounter < 10) {
      if (memHeader > 0xffffff) break; // Safety check

      const nodeType = await this.vAmiga.peek8(memHeader + 0x08);

      if (nodeType === NT_MEMORY) {
        const lower = await this.vAmiga.peek32(memHeader + 0x14);
        const upper = await this.vAmiga.peek32(memHeader + 0x18);

        if (address >= lower && address < upper) {
          // Found the correct MemHeader - update free count
          const freeAddr = memHeader + 0x1c;
          const currentFree = await this.vAmiga.peek32(freeAddr);
          const newFree = currentFree + delta;

          await this.vAmiga.poke32(freeAddr, newFree);
          return;
        }
      }

      memHeader = await this.vAmiga.peek32(memHeader);
      safetyCounter++;
    }

    throw new Error(
      `Could not find MemHeader for address 0x${address.toString(16)}`,
    );
  }

  /**
   * Update the pointer to a chunk in the free list
   */
  private async updatePreviousChunkPointer(
    oldChunk: number,
    newChunk: number,
  ): Promise<void> {
    // Need to find what points to oldChunk and update it to point to newChunk
    // This requires walking the free lists to find the previous pointer
    const execBase = await this.getExecBase();
    const memListAddr = execBase + 0x142;

    let memHeader = await this.vAmiga.peek32(memListAddr);

    let safetyCounter = 0;
    while (memHeader !== 0 && safetyCounter < 10) {
      if (memHeader > 0xffffff) break; // Safety check

      const nodeType = await this.vAmiga.peek8(memHeader + 0x08);

      if (nodeType === NT_MEMORY) {
        const firstChunkAddr = memHeader + 0x10; // Address of first chunk pointer
        const firstChunk = await this.vAmiga.peek32(firstChunkAddr);

        // Check if this memory header's first chunk is the one we're updating
        if (firstChunk === oldChunk) {
          await this.vAmiga.poke32(firstChunkAddr, newChunk);
          return;
        }

        // Walk chunks to find previous one
        let chunk = firstChunk;
        while (chunk !== 0) {
          const nextChunk = await this.vAmiga.peek32(chunk);
          if (nextChunk === oldChunk) {
            await this.vAmiga.poke32(chunk, newChunk);
            return;
          }
          chunk = nextChunk;
        }
      }

      memHeader = await this.vAmiga.peek32(memHeader);
      safetyCounter++;
    }
  }

  /**
   * Free allocated memory back to the OS
   */
  async freeMemory(address: number, size: number): Promise<void> {
    // For now, we'll implement a simple version that just adds the chunk
    // back to the appropriate free list. A full implementation would
    // also try to coalesce adjacent free blocks.

    const alignedSize = (size + 3) & ~3;

    // Find which memory header this address belongs to
    const execBase = await this.getExecBase();
    const memListAddr = execBase + 0x142;

    let memHeader = await this.vAmiga.peek32(memListAddr);

    let safetyCounter = 0;
    while (memHeader !== 0 && safetyCounter < 10) {
      if (memHeader > 0xffffff) break; // Safety check

      const nodeType = await this.vAmiga.peek8(memHeader + 0x08);

      if (nodeType === NT_MEMORY) {
        const lower = await this.vAmiga.peek32(memHeader + 0x14);
        const upper = await this.vAmiga.peek32(memHeader + 0x18);

        if (address >= lower && address < upper) {
          // Add this chunk to the beginning of the free list
          const firstChunkAddr = memHeader + 0x10;
          const oldFirstChunk = await this.vAmiga.peek32(firstChunkAddr);

          // Set up freed chunk
          await this.vAmiga.poke32(address, oldFirstChunk); // next pointer
          await this.vAmiga.poke32(address + 0x04, alignedSize); // size

          // Update memory header to point to this chunk
          await this.vAmiga.poke32(firstChunkAddr, address);

          // Update free bytes count
          const freeAddr = memHeader + 0x1c;
          const currentFree = await this.vAmiga.peek32(freeAddr);
          await this.vAmiga.poke32(freeAddr, currentFree + alignedSize);

          return;
        }
      }

      memHeader = await this.vAmiga.peek32(memHeader);
      safetyCounter++;
    }

    throw new Error(
      `Address ${address.toString(16)} not found in any memory region`,
    );
  }
}
