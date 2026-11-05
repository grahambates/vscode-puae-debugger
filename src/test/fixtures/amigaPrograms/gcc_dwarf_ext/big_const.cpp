// Fixture for DWARF forms/ops dwarfParser.ts once rejected:
//  - a namespace-scope constexpr array >255 bytes that is only read at constant
//    indices is folded away, so GCC describes it with DW_AT_const_value in
//    DW_FORM_block2;
//  - a static function whose variable-but-unused parameter is dropped by IPA-SRA
//    describes that parameter with DW_OP_GNU_parameter_ref.
// Built with: m68k-amiga-elf-gcc -g -Os -mcpu=68000 -fno-exceptions -fno-rtti
//             -nostdlib -nostartfiles -Wl,-e,main big_const.cpp -o big_const.elf
constexpr unsigned short TABLE[160] = {1, 2, 3, 4, 5, 6, 7, 8};

volatile int sink;

__attribute__((noinline)) static void put(int value, int unused) {
  sink = value;
  sink = value + TABLE[3];
}

int main(int argc, char **) {
  put(argc, argc * 3);
  put(argc + 1, argc - 7);
  return TABLE[5];
}
