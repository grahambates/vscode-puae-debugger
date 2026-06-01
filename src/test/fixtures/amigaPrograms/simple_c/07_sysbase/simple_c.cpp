#include <proto/exec.h>
struct ExecBase* SysBase;

extern "C"
__attribute__((used)) __attribute__((section(".text.unlikely"))) void _start() {
	SysBase = *((struct ExecBase**)4UL);
	while(1) {}
}
