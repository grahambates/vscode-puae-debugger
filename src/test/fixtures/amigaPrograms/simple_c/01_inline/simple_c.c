int global_a = 0x11111111;

__attribute__((always_inline)) inline void func_inline(int a) {
	global_a = a;
}

__attribute__((used)) __attribute__((section(".text.unlikely"))) void _start() {
	int local_a = 0x22222222;
	func_inline(local_a);
	{
		int local_b = 0x33333333;
		func_inline(local_b);
		{
			int local_c = 0x44444444;
			func_inline(local_c);
		}
	}
	while(1) {}
}