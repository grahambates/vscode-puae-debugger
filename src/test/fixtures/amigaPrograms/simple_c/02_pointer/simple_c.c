int global_int = 0x11111111;
short global_short = 0x2222;
char global_char = 0x33;

__attribute__((used)) __attribute__((section(".text.unlikely"))) void _start() {
	int* ptr_int = &global_int;
	short* ptr_short = &global_short;
	char* ptr_char = &global_char;
	*ptr_int = 0x99999999;
	*ptr_short = 0x8888;
	*ptr_char = 0x77;
	while(1) {}
}