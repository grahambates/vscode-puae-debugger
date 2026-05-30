int global_int = 0x11111111;

struct Struct {
	int* _int_ptr;
	short _short;
	char _char;
	struct Struct* next;
} globals = {
	._int_ptr = &global_int,
	._short = 0x2222,
	._char = 0x33,
	.next = &globals
} ;

__attribute__((used)) __attribute__((section(".text.unlikely"))) void _start() {
	struct Struct* ptr_struct = &globals;
	*ptr_struct->_int_ptr = 0x99999999;
	ptr_struct->_short = 0x8888;
	ptr_struct->_char = 0x77;
	while(1) {}
}