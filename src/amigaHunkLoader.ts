/**
 * Enhanced hunk loader with OS-aware memory allocation
 * Loads Amiga executables directly into memory bypassing floppy emulation
 */

import { Emulator } from "./emulator";
import { Hunk, HunkType, RelocInfo32 } from "./amigaHunkParser";
import {
  AmigaMemoryMapper,
  AllocatedHunk,
  LoadedProgram,
} from "./amigaMemoryMapper";

export class AmigaHunkLoader {
  private memoryMapper: AmigaMemoryMapper;

  constructor(private vAmiga: Emulator) {
    this.memoryMapper = new AmigaMemoryMapper(vAmiga);
  }

  /**
   * Load hunks into memory with OS-aware allocation
   */
  async loadProgram(hunks: Hunk[]): Promise<LoadedProgram> {
    if (hunks.length === 0) {
      throw new Error("Program loading error: No hunks to load");
    }

    // Phase 1: Allocate memory for all hunks
    const allocations = await this.allocateHunks(hunks);

    // Phase 2: Write hunk data to allocated memory
    await this.writeHunkData(allocations);

    // Phase 3: Apply relocations (must be after data is written)
    await this.applyRelocations(hunks, allocations);

    const totalSize = allocations.reduce((sum, alloc) => sum + alloc.size, 0);

    // Find the first CODE hunk as entry point, fallback to first hunk if no CODE hunk found
    const codeHunk = allocations.find(
      (alloc) => alloc.hunk.hunkType === HunkType.CODE,
    );
    const entryPoint = codeHunk?.address || allocations[0]?.address || 0;

    return {
      entryPoint,
      allocations,
      totalSize,
    };
  }

  /**
   * Allocate memory for all hunks using OS allocation
   */
  private async allocateHunks(hunks: Hunk[]): Promise<AllocatedHunk[]> {
    const allocations: AllocatedHunk[] = [];

    for (const hunk of hunks) {
      console.log(
        `Allocating ${hunk.allocSize} bytes of ${hunk.memType} memory for hunk ${hunk.index}`,
      );

      const address = await this.memoryMapper.allocateMemory(
        hunk.allocSize,
        hunk.memType,
      );

      allocations.push({
        hunk,
        address,
        size: hunk.allocSize,
      });

      console.log(
        `Hunk ${hunk.index} allocated at address $${address.toString(16)}`,
      );
    }

    return allocations;
  }

  /**
   * Apply relocations to resolve inter-hunk references
   */
  private async applyRelocations(
    hunks: Hunk[],
    allocations: AllocatedHunk[],
  ): Promise<void> {
    // Create lookup table for hunk addresses
    const hunkAddresses = new Map<number, number>();
    for (const alloc of allocations) {
      hunkAddresses.set(alloc.hunk.index, alloc.address);
    }

    for (const alloc of allocations) {
      const hunk = alloc.hunk;

      if (hunk.reloc32.length > 0) {
        console.log(
          `Applying ${hunk.reloc32.length} relocation groups for hunk ${hunk.index}`,
        );

        for (const relocInfo of hunk.reloc32) {
          const targetAddress = hunkAddresses.get(relocInfo.target);
          if (targetAddress === undefined) {
            throw new Error(
              `Program loading error: Relocation target hunk ${relocInfo.target} not found`,
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
  private async applyRelocationGroup(
    alloc: AllocatedHunk,
    relocInfo: RelocInfo32,
    targetAddress: number,
  ): Promise<void> {
    for (const offset of relocInfo.offsets) {
      const relocAddress = alloc.address + offset;

      // Read current value at relocation site
      const currentValue = await this.vAmiga.peek32(relocAddress);

      // Add target hunk base address to current value
      const relocatedValue = currentValue + targetAddress;

      // Write back the relocated value
      await this.vAmiga.poke32(relocAddress, relocatedValue);

      console.log(
        `Relocation at $${relocAddress.toString(16)}: ` +
          `$${currentValue.toString(16)} + $${targetAddress.toString(16)} = ` +
          `$${relocatedValue.toString(16)}`,
      );
    }
  }

  /**
   * Write hunk data to allocated memory locations
   */
  private async writeHunkData(allocations: AllocatedHunk[]): Promise<void> {
    for (const alloc of allocations) {
      const hunk = alloc.hunk;

      if (hunk.hunkType === HunkType.BSS) {
        // BSS hunks need to be zeroed
        console.log(
          `Zeroing BSS hunk ${hunk.index} at $${alloc.address.toString(16)}`,
        );
        await this.zeroMemory(alloc.address, alloc.size);
      } else if (hunk.data) {
        // CODE and DATA hunks have binary content
        console.log(
          `Writing ${hunk.data.length} bytes for ${hunk.hunkType} hunk ${hunk.index} ` +
            `at $${alloc.address.toString(16)}`,
        );

        await this.vAmiga.writeMemory(alloc.address, hunk.data);
      }
    }
  }

  /**
   * Zero out a memory region (for BSS hunks)
   */
  private async zeroMemory(address: number, size: number): Promise<void> {
    // Create a buffer of zeros and write
    const zeroBuffer = Buffer.alloc(size);
    await this.vAmiga.writeMemory(address, zeroBuffer);
  }

  /**
   * Free all allocated memory when program is unloaded
   */
  async unloadProgram(program: LoadedProgram): Promise<void> {
    console.log(`Unloading program with ${program.allocations.length} hunks`);

    for (const alloc of program.allocations) {
      console.log(
        `Freeing hunk ${alloc.hunk.index} at $${alloc.address.toString(16)}`,
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
  static async loadFromHunks(
    vAmiga: Emulator,
    hunks: Hunk[],
  ): Promise<LoadedProgram> {
    const loader = new AmigaHunkLoader(vAmiga);
    return await loader.loadProgram(hunks);
  }

  /**
   * Create a program entry point setup
   * Sets up registers and jumps to program start
   */
  async setupProgramEntry(program: LoadedProgram): Promise<void> {
    await this.setupReturnTrampoline();
    await this.clearInterruptMask();
    // Jump pc to entrypoint
    await this.vAmiga.jump(program.entryPoint);
    console.log(
      `Program entry point set to $${program.entryPoint.toString(16)}`,
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
  private async clearInterruptMask(): Promise<void> {
    const cpuInfo = await this.vAmiga.getCpuInfo();
    const sr = Number(cpuInfo.sr) & ~0x0700;
    await this.vAmiga.setRegister("sr", sr);
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
  private async setupReturnTrampoline(): Promise<void> {
    // move.w #$7FFF, $DFF096   ; DMACON - disable all DMA channels
    // move.w #$7FFF, $DFF09A   ; INTENA - disable all interrupts
    // bra.s  *                 ; spin forever
    const TRAMPOLINE_CODE = Buffer.from([
      0x33, 0xfc, 0x7f, 0xff, 0x00, 0xdf, 0xf0, 0x96, 0x33, 0xfc, 0x7f, 0xff,
      0x00, 0xdf, 0xf0, 0x9a, 0x60, 0xfe,
    ]);

    const cpuInfo = await this.vAmiga.getCpuInfo();
    const sp = Number(cpuInfo.a7);

    const trampolineAddress = sp - TRAMPOLINE_CODE.length; // landing pad, ending at the original a7
    const returnAddress = trampolineAddress - 4; // synthetic return address, popped by rts

    await this.vAmiga.writeMemory(trampolineAddress, TRAMPOLINE_CODE);
    await this.vAmiga.poke32(returnAddress, trampolineAddress);
    await this.vAmiga.setRegister("a7", returnAddress);

    console.log(
      `Set up return trampoline at $${trampolineAddress.toString(16)}, a7=$${returnAddress.toString(16)}`,
    );
  }
}

/**
 * Utility function to load a program with full setup
 */
export async function loadAmigaProgram(
  vAmiga: Emulator,
  hunks: Hunk[],
): Promise<LoadedProgram> {
  console.log(`Loading Amiga program with ${hunks.length} hunks`);

  const loader = new AmigaHunkLoader(vAmiga);
  const program = await loader.loadProgram(hunks);

  // Set up program entry point
  await loader.setupProgramEntry(program);

  return program;
}
