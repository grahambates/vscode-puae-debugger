const char* hello = "hello!";
const char* cstr = nullptr;
const short color = [] { return *(volatile short*)0xdff180; }();


extern void (*__preinit_array_start[])() __attribute__((weak));
extern void (*__preinit_array_end[])() __attribute__((weak));
extern void (*__init_array_start[])() __attribute__((weak));
extern void (*__init_array_end[])() __attribute__((weak));
extern void (*__fini_array_start[])() __attribute__((weak));
extern void (*__fini_array_end[])() __attribute__((weak));

int main();

extern "C" __attribute__((used)) __attribute__((section(".text.unlikely"))) void _start() {
	// initialize globals, ctors etc.
	unsigned long count;
	unsigned long i;

	count = __preinit_array_end - __preinit_array_start;
	for (i = 0; i < count; i++)
		__preinit_array_start[i]();

	count = __init_array_end - __init_array_start;
	for (i = 0; i < count; i++)
		__init_array_start[i]();

	main();

	// call dtors
	count = __fini_array_end - __fini_array_start;
	for (i = count; i > 0; i--)
		__fini_array_start[i - 1]();
}


int main() {
	cstr = hello;
	while(1) {}
	return 0;
}

/*
int global_int = 0x11111111;

template <typename T>
struct Template {
	T t;
};

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
};

Template<int> Tint{ 0x11 };
Template<const char*> Tcchar{ "hello!" };


int func_a(const Struct& s) {
	return *s._int_ptr;
}

extern "C"
__attribute__((used)) __attribute__((section(".text.unlikely"))) void _start() {
	struct Struct* ptr_struct = &globals;
	*ptr_struct->_int_ptr = func_a(globals) + Tint.t;
	ptr_struct->_short = 0x8888;
	ptr_struct->_char = 0x77;
	while(1) {}
}*/