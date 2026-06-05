#include <proto/exec.h>
#include <proto/graphics.h>
#include <exec/execbase.h>
#include <graphics/gfxbase.h>
#include <hardware/custom.h>
#include <hardware/dmabits.h>
#include <hardware/intbits.h>

struct ExecBase* SysBase;
volatile struct Custom *custom;
struct GfxBase *GfxBase;

asm(
	".pushsection .text.KPutCharX,\"ax\",@progbits\n"
	".globl KPutCharX\n"
	"KPutCharX:\n"
	"    move.l  a6, -(sp)\n"
	"    move.l  4.w, a6\n"
	"    jsr     -0x204(a6)\n"
	"    move.l  (sp)+, a6\n"
	"    rts\n"
	".popsection"
);
extern "C" void KPutCharX();

typedef unsigned char *va_list;
#define va_start(ap, lastarg) ((ap)=(va_list)(&lastarg+1))

extern "C"
void warpmode(int on) { // bool
	long(*UaeConf)(long mode, int index, const char* param, int param_len, char* outbuf, int outbuf_len);
	UaeConf = (long(*)(long, int, const char*, int, char*, int))0xf0ff60;
	if(*((UWORD *)UaeConf) == 0x4eb9 || *((UWORD *)UaeConf) == 0xa00e) {
		char outbuf;
		UaeConf(82, -1, on ? "cpu_speed max" : "cpu_speed real", 0, &outbuf, 1);
		UaeConf(82, -1, on ? "cpu_cycle_exact false" : "cpu_cycle_exact true", 0, &outbuf, 1);
		UaeConf(82, -1, on ? "cpu_memory_cycle_exact false" : "cpu_memory_cycle_exact true", 0, &outbuf, 1);
		UaeConf(82, -1, on ? "blitter_cycle_exact false" : "blitter_cycle_exact true", 0, &outbuf, 1);
		UaeConf(82, -1, on ? "warp true" : "warp false", 0, &outbuf, 1);
	}
}

//vblank begins at vpos 312 hpos 1 and ends at vpos 25 hpos 1
//vsync begins at line 2 hpos 132 and ends at vpos 5 hpos 18 
void WaitVbl() {
	//debug_start_idle();
	while (1) {
		volatile ULONG vpos=*(volatile ULONG*)0xDFF004;
		vpos&=0x1ff00;
		if (vpos!=(311<<8))
			break;
	}
	while (1) {
		volatile ULONG vpos=*(volatile ULONG*)0xDFF004;
		vpos&=0x1ff00;
		if (vpos==(311<<8))
			break;
	}
	//debug_stop_idle();
}

void TakeSystem() {
	Forbid();

	LoadView(0);
	WaitTOF();
	WaitTOF();

	WaitVbl();
	WaitVbl();

	OwnBlitter();
	WaitBlit();	
	Disable();
	
	custom->intena=0x7fff;//disable all interrupts
	custom->intreq=0x7fff;//Clear any interrupts that were pending
	custom->dmacon=0x7fff;//Clear all DMA channels

	//set all colors black
	for(int a=0;a<32;a++)
		custom->color[a]=0;

	WaitVbl();
	WaitVbl();
}

void WaitLine(USHORT line) {
	while (1) {
		volatile ULONG vpos=*(volatile ULONG*)0xDFF004;
		if(((vpos >> 8) & 511) == line)
			break;
	}
}

static void Wait10() { WaitLine(0x10); }
static void Wait11() { WaitLine(0x11); }
static void Wait12() { WaitLine(0x12); }
static void Wait13() { WaitLine(0x13); }

extern "C"
__attribute__((noinline)) __attribute__((optimize("O1")))
void KPrintF(const char* fmt, ...) {
	va_list vl;
	va_start(vl, fmt);
	RawDoFmt((CONST_STRPTR)fmt, vl, KPutCharX, 0);
}

int global_a = 0x11111111;

int fib(int a) {
	if(a == 1 || a == 2)
		return 1;
	return fib(a - 1) + fib(a - 2);
}

extern "C"
__attribute__((used)) __attribute__((section(".text.unlikely"))) void _start() {
	SysBase = *((struct ExecBase**)4UL);
	GfxBase = (struct GfxBase *)OpenLibrary((CONST_STRPTR)"graphics.library",0);
	custom = (struct Custom*)0xdff000;

	TakeSystem();

	auto a = SysBase->ColdCapture;
	//warpmode(1);
	while(1) {
		Wait10();
		*(volatile unsigned short*)0xDFF180 = 0xf00;
		*(volatile unsigned short*)0xDFF182 = fib(12);
		//KPrintF("fib(%ld) = %ld\n", 5, fib(5));
		*(volatile unsigned short*)0xDFF180 = 0x000;
	}
}
