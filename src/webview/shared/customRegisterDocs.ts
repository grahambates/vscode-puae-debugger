// Amiga custom-register documentation, keyed by register offset (0x000..0x1FE), rendered in
// the DMA profiler tooltip via markdown-to-jsx. Text originates from the old vscode-amiga-debug
// "doc/*.md" set. Repeating register families (COLOR, bitplane/sprite pointers, sprite & audio
// channels) share one body and are expanded by code below; the rest are inline one-offs.

import { CUSTOM_REGISTER_OFFSETS } from "./customRegisters";

// Assemble a doc from a heading + shared body (the family expansion below).
const doc = (heading: string, body: string): string => `**${heading}**\n\n${body}`;

// Shared family bodies (one per family; DATA/DATB and LCH/LCL each share theirs).
const BODY_COLOR = `There are 32 of these registers (xx = 00-31) and together with the banking bits they address the 256 locations in the color palette. There are actually two sets of color regs, selection of which is controlled by the LOCT reg bit. When LOCT = 0 the 4 MSB of red, green and blue video data are selected along with the T bit for genlocks the low order set of registers is also selected as well, so that the 4 bits- values are automatically extended to 8 bits.This provides compatibility with old software. If the full range of palette values are desired, then LOCT can be set high and independent values for the 4 LSB of red, green and blue can be written. The low order color registers do not contain a transparency (T) bit.The table below shows the color register bit usage.The table below shows the color register bit usage.

| Bit| 15| 14| 13| 12| 11| 10| 09| 08| 07| 06| 05| 04| 03| 02| 01| 00  |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---  |
|LOCT=0| T| 0| 0| 0| R7| R6| R5| R4| G7| G6| G5| G4| B7| B6| B5| B4  |
|LOCT=1| 0| 0| 0| 0| R3| R2| R1| R0| G3| G2| G1| G0| B3| B2| B1| B0|

T = TRANSPARENCY, R = RED, G = GREEN, B = BLUET bit of COLOR00 thru COLOR31 sets ZD_pin HI, When that color is T bit of COLOR00 thru COLOR31 sets ZD_pin HI, When that color is selected in all video modes.`; // COLORxx
const BODY_BPLPTR = `Address of bit plane DMA data. These pointers must be reinitialized by the processor or coprocessor to point in the beginning of bit plane date very vertical blank time.`; // BPLxPTH/PTL
const BODY_BPLDAT = `These registers receive the DMA data fetched from RAM by the bit plane address pointers described above. They may also be rewritten by either micro. They act as an 8 word parallel to serial buffer for up to 8 memory 'bit planes'. x=1-8 the parallel to serial conversion ID triggered whenever bitplane #1 is written, inducing the completion of all bit planes for that word (16/32/64 pixels). The MSB is output first, and is therefore always on the left.`; // BPLxDAT
const BODY_SPRPTR = `These pairs of registers contain the address of sprite x DMA data. These address registers must be initialized by the processor or Copper every vertical blank time.`; // SPRxPTH/PTL
const BODY_SPRPOS = `|Bit| Function| Description  |
|---|---|---  |
|15-08| SV7-SV0| Start vertical value.High bit (SV8) is in [SPRxCTL](/hardware:sprxctl) registers.  |
|07-00| SH10-SH3| Sprite horizontal start value. Low order 3 bits are in [SPRxCTL](/hardware:sprxctl) registers. If SSCAN2 bit in FMODE is set, then disable SH10 horizontal coincidence detect.This bit is then free to be used by ALICE as an individual scan double enable.|`; // SPRxPOS
const BODY_SPRCTL = `|Bit| Function| Description  |
|---|---|---  |
|15-08| EV7-EV0| End (stop) vertical value. Low 8 bits  |
|07| ATT| Sprite attach control bit (odd sprites only)  |
|06| SV9| Start vertical value 10th bit  |
|05| EV9| End (stop) vertical value 10th bit  |
|04| SH1=0| Start horizontal value, 70nS increment  |
|03| SH0=0| Start horizontal value 35nS increment  |
|02| SV8| Start vertical value 9th bit  |
|01| EV8| End (stop) vertical value 9th bit  |
|00| SH2| Start horizontal value, 140nS increment|

These registers work together as position, size and feature sprite control registers. They are usually loaded by the sprite DMA channel, during horizontal blank, however they may be loaded by either processor any time. Writing to SPRxCTL disables the corresponding sprite.`; // SPRxCTL
const BODY_SPRDAT = `These registers buffer the sprite image data. They are usually loaded by the sprite DMA channel but may be loaded by either processor at any time. When a horizontal coincidence occurs the buffers are dumped into shift registers and serially outputted to the display, MSB first on the left.  
  
> > Note: Note: Writing to the A buffer enables (arms) the sprite. Writing to the [SPRxCTL](/hardware:sprxctl) registers disables the sprite. If enabled, data in the A and B buffers will be output whenever the beam counter equals the sprite horizontal position value in the [SPRxPOS](/hardware:sprxpos) register. In lowres mode, 1 sprite pixel is 1 bitplane pixel wide.In HRES and SHRES mode, 1 sprite pixel is 2 bitplane pixels. The DATB bits are the 2SBs (worth 2) for the color registers, and MSB for SHRES. DATA bits are LSBs of the pixels.`; // SPRxDATA/DATB
const BODY_AUDLOC = `This pair of registers contains the 20 bit starting address (location) of audio channel x (x = 0,1,2,3) DMA data. This is not a pointer reg and therefore only needs to be reloaded if a different memory location is to be outputted.`; // AUDxLCH/LCL
const BODY_AUDLEN = `This register contains the length (number of words) of audio channel x DMA data.`; // AUDxLEN
const BODY_AUDPER = `This reg contains the period (rate) of audio channel x DMA data transfer. The minimum period is 124 clocks. This means that the smallest number that should be placed in this reg is 124.`; // AUDxPER
const BODY_AUDVOL = `This reg contains the volume setting for audio channel x. Bits 6,5,4,3,2,1,0 specify 65 linear volume levels as shown below.

| Bit| Function  |
|---|---  |
|15-07| Not used  |
|06| Forces volume to max (64 ones, no zeros)  |
|05-00| Sets one of the 64 levels (000000 = no output, 111111 = 63 ones, one zero)|`; // AUDxVOL
const BODY_AUDDAT = `This reg is the audio channel x (x=0,1,2,3) DMA data buffer. It contains 2 bytes of data (each byte is a twos complement signed integer) that are outputted sequentially (with digital to analog conversion)to the audio output pins. With maximum volume, each byte can drive the audio outputs with 0.8 volts (peak to peak,type). The audio DMA channel controller automatically transfers data to this reg from RAM. The processor can also write directly to this reg. When the DMA data is finished (words outputted = length) and the data in this reg has been used, an audio channel interrupt request is set.`; // AUDxDAT

const customRegisterDocs: Record<number, string> = {
  [CUSTOM_REGISTER_OFFSETS.BLTDDAT]: `**Blitter destination data register**

This register holds the data resulting from each word of Blitter operation until it is sent to a RAM destination. This is a dummy address and cannot be read by the microprocessor. The transfer is automatic during Blitter operation.`,
  [CUSTOM_REGISTER_OFFSETS.DMACONR]: `**DMA Control (and blitter status) read**

This register controls all of the DMA channels, and contains blitter DMA status bits.

| Bit| Function| Description  |
|---|---|---  |
|15| SET/CLR| Set/Clear control bit. Determines if bits written with a 1 get set or cleared Bits written with a zero are unchanged  |
|14| BBUSY| Blitter busy status bit (read only)  |
|13| BZERO| Blitter logic zero status bit (read only)  |
|12| X|   |
|11| X|   |
|10| BLTPRI| Blitter DMA priority (over CPU micro) (also called "blitter nasty") (disables /BLS pin, preventing micro from stealing any bus cycles while blitter DMA is running)  |
|09| DMAEN| Enable all DMA below (also UHRES DMA)  |
|08| BPLEN| Bit plane DMA enable  |
|07| COPEN| Coprocessor DMA enable  |
|06| BLTEN| Blitter DMA enable  |
|05| SPREN| Sprite DMA enable  |
|04| DSKEN| Disk DMA enable  |
|03| AUD3EN| Audio channel 3 DMA enable  |
|02| AUD2EN| Audio channel 2 DMA enable  |
|01| AUD1EN| Audio channel 1 DMA enable  |
|00| AUD0EN| Audio channel 0 DMA enable|`,
  [CUSTOM_REGISTER_OFFSETS.VPOSR]: `**Read vert most sig. bits (and frame flop)**

|Bit| 15| 14| 13| 12| 11| 10| 09| 08| 07| 06| 05| 04| 03| 02| 01| 00  |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---  |
|| LOF| I6| I5| I4| I3| I2| I1| I0| LOL| xx| xx| xx| xx| V10| V9| V8|

LOF = Long frame(auto toggle control bit in BPLCON0)I0-I6 Chip identification:I0-I6 Chip identification:  
  
  * 8361 (Regular) or 8370 (Fat) (Agnus-NTSC) = 10
  * 8367 (Pal) or 8371 (Fat-Pal) (Agnus-PAL) = 00
  * 8372 (Fat-hr) (agnushr),thru rev4 = 20 PAL, 30 NTSC
  * 8372 (Fat-hr) (agnushr),rev 5 = 22 PAL, 31 NTSC
  * 8374 (Alice) thru rev 2 = 22 PAL, 32 NTSC
  * 8374 (Alice) rev 3 thru rev 4 = 23 PAL, 33 NTSC

LOL = Long line bit. When low, it indicates short raster line.LOL = Long line bit. When low, it indicates short raster line.V9,10 xx Hires chips only (20,30 identifiers)V9,10 xx Hires chips only (20,30 identifiers)`,
  [CUSTOM_REGISTER_OFFSETS.VHPOSR]: `**Read vert and horiz position of beam, or lightpen**

|Bit| 15| 14| 13| 12| 11| 10| 09| 08| 07| 06| 05| 04| 03| 02| 01| 00  |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---  |
|| V7| V6| V5| V4| V3| V2| V1| V0| H8| H7| H6| H5| H4| H3| H2| H1|

Resolution = 1/160 of screen width (280 ns).`,
  [CUSTOM_REGISTER_OFFSETS.DSKDATR]: `**Disk DMA data read (early read dummy address)**

This register is the disk-DMA data buffer.It contains 2 bytes of data that are either sent to (write) or received from (read) the disk. The DMA controller automatically transfers data to or from this register and RAM, and when the DMA data is finished (length=0) it causes a disk block interrupt.`,
  [CUSTOM_REGISTER_OFFSETS.JOY0DAT]: `**Joystick-mouse 0 data (left vert, horiz)**

These addresses each read a 16 bit register. These in turn are loaded from the MDAT serial stream and are clocked in on the rising edge of SCLK. MLD output is used to parallel load the external parallel-to- serial converter.This in turn is loaded with the 4 quadrature inputs from each of two game controller ports (8 total) plus 8 miscellaneous control bits which are new for LISA and can be read in upper 8 bits of LISAID.Register bits are as follows:Register bits are as follows:Mouse counter usage (pins 1,3 = Yclock, pins 2,4 = Xclock)Mouse counter usage (pins 1,3 = Yclock, pins 2,4 = Xclock)

| Bit| 15| 14| 13| 12| 11| 10| 09| 08| 07| 06| 05| 04| 03| 02| 01| 00  |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---  |
|JOY0DAT| Y7| Y6| Y5| Y4| Y3| Y2| Y1| Y0| X7| X6| X5| X4| X3| X2| X1| X0  |
|JOY1DAT| Y7| Y6| Y5| Y4| Y3| Y2| Y1| Y0| X7| X6| X5| X4| X3| X2| X1| X0|

0 = LEFT CONTROLLER PAIR, 1 = RIGHT CONTROLLER PAIR. (4 counters total).The bit usage for both left and right addresses is shown below. Each 6 bit counter (Y7-Y2,X7-X2) is clocked by 2 of the signals input from the mouse serial stream.Starting with first bit received:Starting with first bit received:

| Serial| Bit name| Description  |
|---|---|---  |
|0| M0H| JOY0DAT Horizontal Clock  |
|1| M0HQ| JOY0DAT Horizontal Clock (quadrature)  |
|2| M0V| JOY0DAT Vertical Clock  |
|3| M0VQ| JOY0DAT Vertical Clock (quadrature)  |
|4| M1V| JOY1DAT Horizontall Clock  |
|5| M1VQ| JOY1DAT Horizontall Clock (quadrature)  |
|6| M1V| JOY1DAT Vertical Clock  |
|7| M1VQ| JOY1DAT Vertical Clock (quadrature)|

Bits 1 and 0 of each counter (Y1-Y0,X1-X0) may be read to determine the state of the related input signal pair. This allows these pins to double as joystick switch inputs. Joystick switch closures can be deciphered as follows:

| Direction| Pin| Counter bits  |
|---|---|---  |
|Forward| 1| Y1 xor Y0 (BIT#09 xor BIT#08)  |
|Left| 3| Y1  |
|Back| 2| X1 xor X0 (BIT#01 xor BIT#00)  |
|Right| 4| X1|`,
  [CUSTOM_REGISTER_OFFSETS.JOY1DAT]: `**Joystick-mouse 1 data (right vert, horiz)**

These addresses each read a 16 bit register. These in turn are loaded from the MDAT serial stream and are clocked in on the rising edge of SCLK. MLD output is used to parallel load the external parallel-to- serial converter.This in turn is loaded with the 4 quadrature inputs from each of two game controller ports (8 total) plus 8 miscellaneous control bits which are new for LISA and can be read in upper 8 bits of LISAID.Register bits are as follows:Register bits are as follows:Mouse counter usage (pins 1,3 = Yclock, pins 2,4 = Xclock)Mouse counter usage (pins 1,3 = Yclock, pins 2,4 = Xclock)

| Bit| 15| 14| 13| 12| 11| 10| 09| 08| 07| 06| 05| 04| 03| 02| 01| 00  |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---  |
|JOY0DAT| Y7| Y6| Y5| Y4| Y3| Y2| Y1| Y0| X7| X6| X5| X4| X3| X2| X1| X0  |
|JOY1DAT| Y7| Y6| Y5| Y4| Y3| Y2| Y1| Y0| X7| X6| X5| X4| X3| X2| X1| X0|

0 = LEFT CONTROLLER PAIR, 1 = RIGHT CONTROLLER PAIR. (4 counters total).The bit usage for both left and right addresses is shown below. Each 6 bit counter (Y7-Y2,X7-X2) is clocked by 2 of the signals input from the mouse serial stream.Starting with first bit received:Starting with first bit received:

| Serial| Bit name| Description  |
|---|---|---  |
|0| M0H| JOY0DAT Horizontal Clock  |
|1| M0HQ| JOY0DAT Horizontal Clock (quadrature)  |
|2| M0V| JOY0DAT Vertical Clock  |
|3| M0VQ| JOY0DAT Vertical Clock (quadrature)  |
|4| M1V| JOY1DAT Horizontall Clock  |
|5| M1VQ| JOY1DAT Horizontall Clock (quadrature)  |
|6| M1V| JOY1DAT Vertical Clock  |
|7| M1VQ| JOY1DAT Vertical Clock (quadrature)|

Bits 1 and 0 of each counter (Y1-Y0,X1-X0) may be read to determine the state of the related input signal pair. This allows these pins to double as joystick switch inputs. Joystick switch closures can be deciphered as follows:

| Direction| Pin| Counter bits  |
|---|---|---  |
|Forward| 1| Y1 xor Y0 (BIT#09 xor BIT#08)  |
|Left| 3| Y1  |
|Back| 2| X1 xor X0 (BIT#01 xor BIT#00)  |
|Right| 4| X1|`,
  [CUSTOM_REGISTER_OFFSETS.CLXDAT]: `**Collision detection register (read and clear)**

This address reads (and clears) the collision detection reg. The bit assignments are :  
  
*Note: Playfield 1 is all odd numbered enabled bit planes. Playfield 2 is all even numbered enabled bit planes.*

| Bit| Collision registered  |
| ---|---  |
| 15| Not used  |
| 14| Sprite 4 (or 5) to Sprite 6 (or 7)  |
| 13| Sprite 2 (or 3) to Sprite 6 (or 7)  |
| 12| Sprite 2 (or 3) to Sprite 4 (or 5)  |
| 11| Sprite 0 (or 1) to Sprite 6 (or 7)  |
| 10| Sprite 0 (or 1) to Sprite 4 (or 5)  |
| 09| Sprite 0 (or 1) to Sprite 2 (or 3)  |
| 08| Playfield 2 to Sprite 6 (or 7)  |
| 07| Playfield 2 to Sprite 4 (or 5)  |
| 06| Playfield 2 to Sprite 2 (or 3)  |
| 05| Playfield 2 to Sprite 0 (or 1)  |
| 04| Playfield 1 to Sprite 6 (or 7)  |
| 03| Playfield 1 to Sprite 4 (or 5)  |
| 02| Playfield 1 to Sprite 2 (or 3)  |
| 01| Playfield 1 to Sprite 0 (or 1)  |
| 00| Playfield 1 to Playfield 2|`,
  [CUSTOM_REGISTER_OFFSETS.ADKCONR]: `**Audio, Disk, UART Control Read**

|Bit| Function| Description  |
|---|---|---  |
|15| SET/CLEAR| Set/clear control bit.determines if bits written with a 1 get set or cleared.bits written with a zero are always unchanged.  |
|14-13| PRECOMP 1-0| 00 : none 01 : 140 ns 10 : 280 ns 11 : 560 ns  |
|12| MFMPREC| (1 = MFM precomp / 0 = GCR precomp)  |
|11| UARTBRK| Forces a UART break (clears TXD) if true  |
|10| WORDSYNC| Enables disk read synchronizing on a word equal to DISK SYNC CODE, Located in address DSKSYNC (7E).  |
|09| MSBSYNC| Enables disk read synchronizing on the MSB (most significant bit) appl type GCR  |
|08| FAST| Disk data clock rate control : 1 : fast(2us) 0 : slow(4us) (Fast for MFM or 2us,slow for 4us GCR)  |
|07| USE3PN| Use audio channel 3 to modulate nothing  |
|06| USE2P3| Use audio channel 2 to modulate period of channel 3  |
|05| USE1P2| Use audio channel 1 to modulate period of channel 2  |
|04| USE0P1| Use audio channel 0 to modulate period of channel 1  |
|03| USE3VN| Use audio channel 3 to modulate nothing  |
|02| USE2V3| Use audio channel 2 to modulate volume of channel 3  |
|01| USE1V2| Use audio channel 1 to modulate volume of channel 2  |
|00| USE0V1| Use audio channel 0 to modulate volume of channel 1|

> Note: If both period and volume are modulated on the same channel, the period and volume will be alternated. First AUDxDAT word is used for V6-V0 of UDxVOL. Second AUDxDAT word is used for P15-P0 of AUDxPER. This alternating sequence is repeated.`,
  [CUSTOM_REGISTER_OFFSETS.POT0DAT]: `**Pot counter data left pair (vert, horiz)**

These addresses each read a pair of 8 bit pot counters. (4 counters total). The bit assignment for both addresses is shown below. The counters are stopped by signals from 2 controller connectors (left-right) with 2 pins each.

| Bit| 15| 14| 13| 12| 11| 10| 09| 08| 07| 06| 05| 04| 03| 02| 01| 00  |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---  |
|RIGHT| Y7| Y6| Y5| Y4| Y3| Y2| Y1| Y0| X7| X6| X5| X4| X3| X2| X1| X0  |
|LEFT| Y7| Y6| Y5| Y4| Y3| Y2| Y1| Y0| X7| X6| X5| X4| X3| X2| X1| X0|

|Connector| Paula  |
|---|---  |
|Loc.| Dir.| Sym.| Pin| Pin  |
|RIGHT| Y| RX| 9| 33  |
|RIGHT| X| RX| 5| 32  |
|LEFT| Y| LY| 9| 36  |
|LEFT| X| LX| 5| 35|

With normal (NTSC or PAL) horiz. line rate, the pots will give a full scale (FF) reading with about 500kohms in one frame time. With proportionally faster horiz line times, the counters will count proportionally faster. This should be noted when doing variable beam displays.`,
  [CUSTOM_REGISTER_OFFSETS.POT1DAT]: `**Pot counter data right pair (vert, horiz)**

These addresses each read a pair of 8 bit pot counters. (4 counters total). The bit assignment for both addresses is shown below. The counters are stopped by signals from 2 controller connectors (left-right) with 2 pins each.

| Bit| 15| 14| 13| 12| 11| 10| 09| 08| 07| 06| 05| 04| 03| 02| 01| 00  |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---  |
|RIGHT| Y7| Y6| Y5| Y4| Y3| Y2| Y1| Y0| X7| X6| X5| X4| X3| X2| X1| X0  |
|LEFT| Y7| Y6| Y5| Y4| Y3| Y2| Y1| Y0| X7| X6| X5| X4| X3| X2| X1| X0|

|Connector| Paula  |
|---|---  |
|Loc.| Dir.| Sym.| Pin| Pin  |
|RIGHT| Y| RX| 9| 33  |
|RIGHT| X| RX| 5| 32  |
|LEFT| Y| LY| 9| 36  |
|LEFT| X| LX| 5| 35|

With normal (NTSC or PAL) horiz. line rate, the pots will give a full scale (FF) reading with about 500kohms in one frame time. With proportionally faster horiz line times, the counters will count proportionally faster. This should be noted when doing variable beam displays.`,
  [CUSTOM_REGISTER_OFFSETS.POTGOR]: `**Pot pin data read**

This register controls a 4 bit bi-direction I/O port that shares the same 4 pins as the 4 pot counters above.

| Bit| Function| Description  |
|---|---|---  |
|15| OUTRY| Output enable for Paula pin 33  |
|14| DATRY| I/O data Paula pin 33  |
|13| OUTRX| Output enable for Paula pin 32  |
|12| DATRX| I/O data Paula pin 32  |
|11| OUTLY| Out put enable for Paula pin 36  |
|10| DATLY| I/O data Paula pin 36  |
|09| OUTLX| Output enable for Paula pin 35  |
|08| DATLX| I/O data Paula pin 35  |
|07-01| X| Not used  |
|00| START| Start pots (dump capacitors,start counters)|`,
  [CUSTOM_REGISTER_OFFSETS.SERDATR]: `**Pot pin data read**

SERDATR - Serial port data and status read.  
  
# Overview

This address reads data from a recive data buffer. Data in this This address reads data from a recive data buffer. Data in this buffer is loaded from a receiving shift register whenever it is full. Several interrupt request bits are also read at this address, along with the data as shown below.

| Bit| Function| Description  |
|---|---|---  |
|15| OVRUN| Serial port receiver overun  |
|14| RBF| Serial port receive buffer full (mirror)  |
|13| TBE| Serial port transmit buffer empty (mirror)  |
|12| TSRE| Serial port transmit shift reg. empty  |
|11| RXD| RXD pin receives UART serial data for direct bit test by the micro.  |
|10| X| Not used.  |
|09| STP| Stop bit  |
|08| STP-DB8| Stop bit if LONG, data bit if not.  |
|07| DB7| Data bit.  |
|06| DB6| Data bit.  |
|05| DB5| Data bit.  |
|04| DB4| Data bit.  |
|03| DB3| Data bit.  |
|02| DB2| Data bit.  |
|01| DB1| Data bit.  |
|00| DB0| Data bit.|`,
  [CUSTOM_REGISTER_OFFSETS.DSKBYTR]: `**Disk data byte and status read**

This register is the Disk-Microprocessor data buffer. Data from the disk (in read mode) is loaded into this register one byte at a time, and bit 15 (DSKBYT) is set true.

| Bit| Function| Description  |
|---|---|---  |
|15| DSKBYT| Disk byte ready (reset on read)  |
|14| DMAON| DMAEN (DSKLEN) & DMAEN (DMACON) & DSKEN (DMACON)  |
|13| DISKWRITE| Mirror of bit 14 (WRITE) in DSKLEN  |
|12| WORDEQUAL| This bit true only while DSKSYNC register equals the data from disk  |
|11-08| 0| Not used  |
|07-00| DATA| Disk byte data|`,
  [CUSTOM_REGISTER_OFFSETS.INTENAR]: `**Interrupt enable bits (read)**

This register contains interrupt enable bits. The bit assignment for both the request, and enable registers is given below.

| Bit| Function| Level| Description  |
|---|---|---|---  |
|15| SET/CLR| | Set/clear control bit. Determines if bits written with a 1 get set or cleared. Bits written with a zero are always unchanged.  |
|14| INTEN| | Master interrupt (enable only, no request)  |
|13| EXTER| 6| External interrupt  |
|12| DSKSYN| 5| Disk sync register (DSKSYNC) matches disk  |
|11| RBF| 5| Serial port receive buffer full  |
|10| AUD3| 4| Audio channel 3 block finished  |
|09| AUD2| 4| Audio channel 2 block finished  |
|08| AUD1| 4| Audio channel 1 block finished  |
|07| AUD0| 4| Audio channel 0 block finished  |
|06| BLIT| 3| Blitter has finished  |
|05| VERTB| 3| Start of vertical blank  |
|04| COPER| 3| Coprocessor  |
|03| PORTS| 2| I/O Ports and timers  |
|02| SOFT| 1| Reserved for software initiated interrupt.  |
|01| DSKBLK| 1| Disk block finished  |
|00| TBE| 1| Serial port transmit buffer empty|`,
  [CUSTOM_REGISTER_OFFSETS.INTREQR]: `**Interrupt request bits (read)**

This register contains interrupt request bits (or flags). These bits may be polled by the processor, and if enabled by the bits listed in the next register, they may cause processor interrupts. Both a set and clear operation are required to load arbitrary data into this register.

| Bit| Function| Level| Description  |
|---|---|---|---  |
|15| SET/CLR| | Set/clear control bit. Determines if bits written with a 1 get set or cleared. Bits written with a zero are always unchanged.  |
|14| INTEN| | Master interrupt (enable only, no request)  |
|13| EXTER| 6| External interrupt  |
|12| DSKSYN| 5| Disk sync register (DSKSYNC) matches disk  |
|11| RBF| 5| Serial port receive buffer full  |
|10| AUD3| 4| Audio channel 3 block finished  |
|09| AUD2| 4| Audio channel 2 block finished  |
|08| AUD1| 4| Audio channel 1 block finished  |
|07| AUD0| 4| Audio channel 0 block finished  |
|06| BLIT| 3| Blitter has finished  |
|05| VERTB| 3| Start of vertical blank  |
|04| COPER| 3| Coprocessor  |
|03| PORTS| 2| I/O Ports and timers  |
|02| SOFT| 1| Reserved for software initiated interrupt.  |
|01| DSKBLK| 1| Disk block finished  |
|00| TBE| 1| Serial port transmit buffer empty|`,
  [CUSTOM_REGISTER_OFFSETS.DSKPTH]: `**Disk Pointer (high 5 bits) (old-3 bits)**

This pair of registers contains the 20 bit address of disk DMA data. These address registers must be initialized by the processor or coprocessor before disk DMA is enabled.`,
  [CUSTOM_REGISTER_OFFSETS.DSKPTL]: `**Disk Pointer (low 15 bits)**

This pair of registers contains the 20 bit address of disk DMA data. These address registers must be initialized by the processor or coprocessor before disk DMA is enabled.`,
  [CUSTOM_REGISTER_OFFSETS.DSKLEN]: `**Disk length**

|Bit| Function| Description  |
|---|---|---  |
|15| DMAEN| Disk DMA enable  |
|14| WRITE| Disk write (RAM or disk) if 1  |
|13-0| LENGTH| Length (# of words) of DMA data.|`,
  [CUSTOM_REGISTER_OFFSETS.DSKDAT]: `**Disk DMA data write**

This register is the disk-DMA data buffer.It contains 2 bytes of data that are either sent to (write) or received from (read) the disk. The DMA controller automatically transfers data to or from this register and RAM, and when the DMA data is finished (length=0) it causes a disk block interrupt.`,
  [CUSTOM_REGISTER_OFFSETS.REFPTR]: `**Refresh pointer**

This register is used as a dynamic RAM refresh address generator. It's writable for test purposes only, and should never be written by the microprocessor.`,
  [CUSTOM_REGISTER_OFFSETS.VPOSW]: `**Write most sig. bits (and frame flop)**

|Bit| 15| 14| 13| 12| 11| 10| 09| 08| 07| 06| 05| 04| 03| 02| 01| 00  |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---  |
|| LOF| I6| I5| I4| I3| I2| I1| I0| LOL| xx| xx| xx| xx| V10| V9| V8|

LOF = Long frame(auto toggle control bit in BPLCON0)I0-I6 Chip identification:I0-I6 Chip identification:  
  
  * 8361 (Regular) or 8370 (Fat) (Agnus-NTSC) = 10
  * 8367 (Pal) or 8371 (Fat-Pal) (Agnus-PAL) = 00
  * 8372 (Fat-hr) (agnushr),thru rev4 = 20 PAL, 30 NTSC
  * 8372 (Fat-hr) (agnushr),rev 5 = 22 PAL, 31 NTSC
  * 8374 (Alice) thru rev 2 = 22 PAL, 32 NTSC
  * 8374 (Alice) rev 3 thru rev 4 = 23 PAL, 33 NTSC

LOL = Long line bit. When low, it indicates short raster line.LOL = Long line bit. When low, it indicates short raster line.V9,10 xx Hires chips only (20,30 identifiers)V9,10 xx Hires chips only (20,30 identifiers)`,
  [CUSTOM_REGISTER_OFFSETS.VHPOSW]: `**Write vert and horiz position of beam, or lightpen**

|Bit| 15| 14| 13| 12| 11| 10| 09| 08| 07| 06| 05| 04| 03| 02| 01| 00  |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---  |
|| V7| V6| V5| V4| V3| V2| V1| V0| H8| H7| H6| H5| H4| H3| H2| H1|

Resolution = 1/160 of screen width (280 ns).`,
  [CUSTOM_REGISTER_OFFSETS.COPCON]: `**Coprocessor control register**

This is a-1 bit register that when set true, allows the coprocessor to access the blitter hardware. This bit is cleared power on reset, so that the coprocessor cannot access the blitter hardware.

| BIT#| NAME| FUNCTION  |
|---|---|---  |
|01| CDANG| Coprocessor danger mode. Allows coprocessor access to all RGA registers if true. (if 0, access to RGA>DFF07E) (On old chips access to only RGA>DFF03E if CDANG=1) (see VPOSR)|`,
  [CUSTOM_REGISTER_OFFSETS.SERDAT]: `**Serial port data and stop bits write**

This address writes data to a transmit data buffer. Data from this buffer is moved into a serial shift register for output transmission whenever it is empty. This sets the interrupt request TBE (transmit buffer empty).A stop bit must be provided as part of the data word. A stop bit must be provided as part of the data word. The length of the data word is set by the position of the stop bit.

| Bit| 15| 14| 13| 12| 11| 10| 09| 08| 07| 06| 05| 04| 03| 02| 01| 00  |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---  |
|| 0| 0| 0| 0| 0| 0| S| D8| D7| D6| D5| D4| D3| D2| D1| D0|`,
  [CUSTOM_REGISTER_OFFSETS.SERPER]: `**Serial port period and control**

This register contains the control bit LONG referred to above, and a 15 bit number defining the serial port Baud rate. If this number is N,then the baud rate is 1 bit every (N+1)*.2794 microseconds.

| Bit| Function| Description  |
|---|---|---  |
|15| LONG| Defines serial receive as 9 bit word.  |
|14-00| RATE| Defines baud rate=1/((N+1)*.2794 microseconds)|`,
  [CUSTOM_REGISTER_OFFSETS.POTGO]: `**Pot port (4 bit) bi-direction and data and pot counter start**`,
  [CUSTOM_REGISTER_OFFSETS.JOYTEST]: `**Write to all 4 joystick-mouse counters at once**

Mouse counter write test data:

| Bit| 15| 14| 13| 12| 11| 10| 09| 08| 07| 06| 05| 04| 03| 02| 01| 00  |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---  |
|JOY0DAT| Y7| Y6| Y5| Y4| Y3| Y2| Y1| Y0| X7| X6| X5| X4| X3| X2| X1| X0  |
|JOY1DAT| Y7| Y6| Y5| Y4| Y3| Y2| Y1| Y0| X7| X6| X5| X4| X3| X2| X1| X0|`,
  [CUSTOM_REGISTER_OFFSETS.STREQU]: `**Strobe for horiz sync with VB (vert blank) and EQU**

One of the first 3 strobe addresses above, it is placed on the RGA bus during the first refresh time slot of every other line, to identify lines with long counts (228- NTSC, HTOTAL+2- VARBEAMEN=1 hires chips only).There are 4 refresh time slots and any not used for strobes will leave a null (1FE) address on the RGA bus.`,
  [CUSTOM_REGISTER_OFFSETS.STRVBL]: `**Strobe for horiz sync with VB**

One of the first 3 strobe addresses above, it is placed on the RGA bus during the first refresh time slot of every other line, to identify lines with long counts (228- NTSC, HTOTAL+2- VARBEAMEN=1 hires chips only).There are 4 refresh time slots and any not used for strobes will leave a null (1FE) address on the RGA bus.`,
  [CUSTOM_REGISTER_OFFSETS.STRHOR]: `**Strobe for horiz sync**

One of the first 3 strobe addresses above, it is placed on the RGA bus during the first refresh time slot of every other line, to identify lines with long counts (228- NTSC, HTOTAL+2- VARBEAMEN=1 hires chips only).There are 4 refresh time slots and any not used for strobes will leave a null (1FE) address on the RGA bus.`,
  [CUSTOM_REGISTER_OFFSETS.STRLONG]: `**Strobe for identification of long horiz line (228CC)**

One of the first 3 strobe addresses above, it is placed on the RGA bus during the first refresh time slot of every other line, to identify lines with long counts (228- NTSC, HTOTAL+2- VARBEAMEN=1 hires chips only).There are 4 refresh time slots and any not used for strobes will leave a null (1FE) address on the RGA bus.`,
  [CUSTOM_REGISTER_OFFSETS.BLTCON0]: `**Blitter control register 0**

These two control registers are used together to control blitter operations. There are 2 basic modes, are and line, which are selected by bit 0 of BLTCON1, as show below.

|AREA MODE Bit| BLTCON0| BLTCON1|LINE MODE Bit| BLTCON0| BLTCON1  |
|---:|---|---|---:|---|---|
|15| ASH3| BSH3| 15| ASH3| BSH3  |
|14| ASH2| BSH2| 14| ASH2| BSH2  |
|13| ASH1| BSH1| 13| ASH1| BSH1  |
|12| ASA0| BSH0| 12| ASH0| BSH0  |
|11| USEA| 0| 11| 1| 0  |
|10| USEB| 0| 10| 0| 0  |
|09| USEC| 0| 09| 1| 0  |
|08| USED| 0| 08| 1| 0  |
|07| LF7| DOFF| 07| LF7| DPFF  |
|06| LF6| 0| 06| LF6| SIGN  |
|05| LF5| 0| 05| LF5| OVF  |
|04| LF4| EFE| 04| LF4| SUD  |
|03| LF3| IFE| 03| LF3| SUL  |
|02| LF2| FCI| 02| LF2| AUL  |
|01| LF1| DESC| 01| LF1| SING  |
|00| LF0| LINE(=0)| 00| LF0| LINE(=1)|

|Function| Description  |
|---|---  |
|ASH3-0| Shift value of A source  |
|BSH3-0| Shift value of B source and line texture  |
|USEA| Mode control bit to use source A  |
|USEB| Mode control bit to use source B  |
|USEC| Mode control bit to use source C  |
|USED| Mode control bit to use destination D  |
|LF7-0| Logic function minterm select lines  |
|EFE| Exclusive fill enable  |
|IFE| Inclusive fill enable  |
|FCI| Fill carry input  |
|DESC| Descending (dec address)control bit  |
|LINE| Line mode control bit  |
|SIGN| Line draw sign flag  |
|OVF| Line/draw r/l word overflow flag  |
|SUD| Line draw, Sometimes up or down (=AUD)  |
|SUL| Line draw, Sometimes up or left  |
|AUL| Line draw, Always up or left  |
|SING| Line draw, Single bit per horiz line  |
|DOFF| Disables the D output- for external ALUs The cycle occurs normally, but the data bus is tristate (hires chips only)|

**Calculation of LF7->LF0 copy mask**

|Bit|Ch A|Ch B|Ch C|Example expected on D|
|:-|:-:|:-:|:-:|:-:|
|LF0|0|0|0|0|
|LF1|0|0|1|0|
|LF2|0|1|0|0|
|LF3|0|1|1|0|
|LF4|1|0|0|1|
|LF5|1|0|1|1|
|LF6|1|1|0|1|
|LF7|1|1|1|1|

Result for BLTCON0 %11110000=$f0 => 'move.w #$??f0,BLTCON0(a6)'`,
  [CUSTOM_REGISTER_OFFSETS.BLTCON1]: `**Blitter control register 0 (lower 8 bits) This is to speed up software - the upper bits are often the same.**

These two control registers are used together to control blitter operations. There are 2 basic modes, are and line, which are selected by bit 0 of BLTCON1, as show below.

| AREA MODE| LINE MODE  |
|---|---  |
|Bit| BLTCON0| BLTCON1| Bit| BLTCON0| BLTCON1  |
|15| ASH3| BSH3| 15| ASH3| BSH3  |
|14| ASH2| BSH2| 14| ASH2| BSH2  |
|13| ASH1| BSH1| 13| ASH1| BSH1  |
|12| ASA0| BSH0| 12| ASH0| BSH0  |
|11| USEA| 0| 11| 1| 0  |
|10| USEB| 0| 10| 0| 0  |
|09| USEC| 0| 09| 1| 0  |
|08| USED| 0| 08| 1| 0  |
|07| LF7| DOFF| 07| LF7| DPFF  |
|06| LF6| 0| 06| LF6| SIGN  |
|05| LF5| 0| 05| LF5| OVF  |
|04| LF4| EFE| 04| LF4| SUD  |
|03| LF3| IFE| 03| LF3| SUL  |
|02| LF2| FCI| 02| LF2| AUL  |
|01| LF1| DESC| 01| LF1| SING  |
|00| LF0| LINE(=0)| 00| LF0| LINE(=1)|

|Function| Description  |
|---|---  |
|ASH3-0| Shift value of A source  |
|BSH3-0| Shift value of B source and line texture  |
|USEA| Mode control bit to use source A  |
|USEB| Mode control bit to use source B  |
|USEC| Mode control bit to use source C  |
|USED| Mode control bit to use destination D  |
|LF7-0| Logic function minterm select lines  |
|EFE| Exclusive fill enable  |
|IFE| Inclusive fill enable  |
|FCI| Fill carry input  |
|DESC| Descending (dec address)control bit  |
|LINE| Line mode control bit  |
|SIGN| Line draw sign flag  |
|OVF| Line/draw r/l word overflow flag  |
|SUD| Line draw, Sometimes up or down (=AUD)  |
|SUL| Line draw, Sometimes up or left  |
|AUL| Line draw, Always up or left  |
|SING| Line draw, Single bit per horiz line  |
|DOFF| Disables the D output- for external ALUs The cycle occurs normally, but the data bus is tristate (hires chips only)|`,
  [CUSTOM_REGISTER_OFFSETS.BLTAFWM]: `**Blitter first word mask for source A**

The patterns in the two registers are "anded" with the first and last words of each line of data from Source A into the Blitter. A zero in any bit overrides data from Source A. These registers should be set to all "ones" for fill mode or for line drawing mode.`,
  [CUSTOM_REGISTER_OFFSETS.BLTALWM]: `**Blitter last word mask for source A**

The patterns in the two registers are "anded" with the first and last words of each line of data from Source A into the Blitter. A zero in any bit overrides data from Source A. These registers should be set to all "ones" for fill mode or for line drawing mode.`,
  [CUSTOM_REGISTER_OFFSETS.BLTCPTH]: `**Blitter pointer to source C (high 5 bits)**

This pair of registers contains the 20 bit address of Blitter source (x=A,B,C) or dest. (x=D) DMA data. This pointer must be preloaded with the starting address of the data to be processed by the blitter. After the Blitter is finished, it will contain the last data address (plus increment and modulo).`,
  [CUSTOM_REGISTER_OFFSETS.BLTCPTL]: `**Blitter pointer to source C (low 15 bits)**

This pair of registers contains the 20 bit address of Blitter source (x=A,B,C) or dest. (x=D) DMA data. This pointer must be preloaded with the starting address of the data to be processed by the blitter. After the Blitter is finished, it will contain the last data address (plus increment and modulo).`,
  [CUSTOM_REGISTER_OFFSETS.BLTBPTH]: `**Blitter pointer to source B (high 5 bits)**

This pair of registers contains the 20 bit address of Blitter source (x=A,B,C) or dest. (x=D) DMA data. This pointer must be preloaded with the starting address of the data to be processed by the blitter. After the Blitter is finished, it will contain the last data address (plus increment and modulo).`,
  [CUSTOM_REGISTER_OFFSETS.BLTBPTL]: `**Blitter pointer to source B (low 15 bits)**

This pair of registers contains the 20 bit address of Blitter source (x=A,B,C) or dest. (x=D) DMA data. This pointer must be preloaded with the starting address of the data to be processed by the blitter. After the Blitter is finished, it will contain the last data address (plus increment and modulo).`,
  [CUSTOM_REGISTER_OFFSETS.BLTAPTH]: `**Blitter pointer to source A (high 5 bits)**

This pair of registers contains the 20 bit address of Blitter source (x=A,B,C) or dest. (x=D) DMA data. This pointer must be preloaded with the starting address of the data to be processed by the blitter. After the Blitter is finished, it will contain the last data address (plus increment and modulo).`,
  [CUSTOM_REGISTER_OFFSETS.BLTAPTL]: `**Blitter pointer to source A (low 15 bits)**

This pair of registers contains the 20 bit address of Blitter source (x=A,B,C) or dest. (x=D) DMA data. This pointer must be preloaded with the starting address of the data to be processed by the blitter. After the Blitter is finished, it will contain the last data address (plus increment and modulo).`,
  [CUSTOM_REGISTER_OFFSETS.BLTDPTH]: `**Blitter pointer to destination D (high 5 bits)**

This pair of registers contains the 20 bit address of Blitter source (x=A,B,C) or dest. (x=D) DMA data. This pointer must be preloaded with the starting address of the data to be processed by the blitter. After the Blitter is finished, it will contain the last data address (plus increment and modulo).`,
  [CUSTOM_REGISTER_OFFSETS.BLTDPTL]: `**Blitter pointer to destination D (low 15 bits)**

This pair of registers contains the 20 bit address of Blitter source (x=A,B,C) or dest. (x=D) DMA data. This pointer must be preloaded with the starting address of the data to be processed by the blitter. After the Blitter is finished, it will contain the last data address (plus increment and modulo).`,
  [CUSTOM_REGISTER_OFFSETS.BLTSIZE]: `**Blitter start and size (width, height)**

This register contains the width and height of the blitter operation (in line mode width must = 2, height = line length). Writing to this register will start the Blitter, and should be done last, after all pointers and control registers have been initialized.

| Bit| 15| 14| 13| 12| 11| 10| 09| 08| 07| 06| 05| 04| 03| 02| 01| 00  |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---  |
|| H9| H8| H7| H6| H5| H4| H3| H2| H1| H0| W5| W4| W3| W2| W1| W0|

H = Height = Vertical lines (10 bits = 1024 lines max) W = Width = Horiz pixels (6 bits = 64 words = 1024 pixels max)`,
  [CUSTOM_REGISTER_OFFSETS.BLTCON0L]: `**Pot pin data read**

These two control registers are used together to control blitter operations. There are 2 basic modes, are and line, which are selected by bit 0 of BLTCON1, as show below.

| AREA MODE| LINE MODE  |
|---|---  |
|Bit| BLTCON0| BLTCON1| Bit| BLTCON0| BLTCON1  |
|15| ASH3| BSH3| 15| ASH3| BSH3  |
|14| ASH2| BSH2| 14| ASH2| BSH2  |
|13| ASH1| BSH1| 13| ASH1| BSH1  |
|12| ASA0| BSH0| 12| ASH0| BSH0  |
|11| USEA| 0| 11| 1| 0  |
|10| USEB| 0| 10| 0| 0  |
|09| USEC| 0| 09| 1| 0  |
|08| USED| 0| 08| 1| 0  |
|07| LF7| DOFF| 07| LF7| DPFF  |
|06| LF6| 0| 06| LF6| SIGN  |
|05| LF5| 0| 05| LF5| OVF  |
|04| LF4| EFE| 04| LF4| SUD  |
|03| LF3| IFE| 03| LF3| SUL  |
|02| LF2| FCI| 02| LF2| AUL  |
|01| LF1| DESC| 01| LF1| SING  |
|00| LF0| LINE(=0)| 00| LF0| LINE(=1)|

|Function| Description  |
|---|---  |
|ASH3-0| Shift value of A source  |
|BSH3-0| Shift value of B source and line texture  |
|USEA| Mode control bit to use source A  |
|USEB| Mode control bit to use source B  |
|USEC| Mode control bit to use source C  |
|USED| Mode control bit to use destination D  |
|LF7-0| Logic function minterm select lines  |
|EFE| Exclusive fill enable  |
|IFE| Inclusive fill enable  |
|FCI| Fill carry input  |
|DESC| Descending (dec address)control bit  |
|LINE| Line mode control bit  |
|SIGN| Line draw sign flag  |
|OVF| Line/draw r/l word overflow flag  |
|SUD| Line draw, Sometimes up or down (=AUD)  |
|SUL| Line draw, Sometimes up or left  |
|AUL| Line draw, Always up or left  |
|SING| Line draw, Single bit per horiz line  |
|DOFF| Disables the D output- for external ALUs The cycle occurs normally, but the data bus is tristate (hires chips only)|`,
  [CUSTOM_REGISTER_OFFSETS.BLTSIZV]: `**Blitter vertical size (15 bit height)**

|Bit| 15| 14| 13| 12| 11| 10| 09| 08| 07| 06| 05| 04| 03| 02| 01| 00  |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---  |
|| 0| H14| H13| H12| H11| H10| H9| H8| H7| H6| H5| H4| H3| H2| H1| H0|

These are the blitter size regs for blits larger than the earlier chips could accept. The original commands are retained for compatibility. BLTSIZV should be written first, followed by BLTSIZH, which starts the blitter. BLTSIZV need not be rewritten for subsequent bits if the vertical size is the same. Max size of blit 32k pixels * 32k lines.`,
  [CUSTOM_REGISTER_OFFSETS.BLTSIZH]: `**Blitter horizontal size & start (11 bit width)**

|Bit| 15| 14| 13| 12| 11| 10| 09| 08| 07| 06| 05| 04| 03| 02| 01| 00  |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---  |
|| 0| 0| 0| 0| 0| W10| W9| W8| W7| W6| W5| W4| W3| W2| W1| W0|`,
  [CUSTOM_REGISTER_OFFSETS.BLTCMOD]: `**Blitter modulo for source C**

This register contains the Modulo for Blitter source (x=A,B,C) or Dest (x=D). A modulo is a number that is automatically added to the address at the end of each line, in order that the address then points to the start of the next line. Each source or destination has it's own Modulo, allowing each to be different in size, while an identical area of each is used in the Blitter operation.`,
  [CUSTOM_REGISTER_OFFSETS.BLTBMOD]: `**Blitter modulo for source B**

This register contains the Modulo for Blitter source (x=A,B,C) or Dest (x=D). A modulo is a number that is automatically added to the address at the end of each line, in order that the address then points to the start of the next line. Each source or destination has it's own Modulo, allowing each to be different in size, while an identical area of each is used in the Blitter operation.`,
  [CUSTOM_REGISTER_OFFSETS.BLTAMOD]: `**Blitter modulo for source A**

This register contains the Modulo for Blitter source (x=A,B,C) or Dest (x=D). A modulo is a number that is automatically added to the address at the end of each line, in order that the address then points to the start of the next line. Each source or destination has it's own Modulo, allowing each to be different in size, while an identical area of each is used in the Blitter operation.`,
  [CUSTOM_REGISTER_OFFSETS.BLTDMOD]: `**Blitter modulo for destination D**

This register contains the Modulo for Blitter source (x=A,B,C) or Dest (x=D). A modulo is a number that is automatically added to the address at the end of each line, in order that the address then points to the start of the next line. Each source or destination has it's own Modulo, allowing each to be different in size, while an identical area of each is used in the Blitter operation.`,
  [CUSTOM_REGISTER_OFFSETS.BLTCDAT]: `**Blitter source C data register**

This register hold Source x (x=A,B,C) data for use by the Blitter. It is normally loaded by the Blitter DMA channel, however it may also be preloaded by the microprocessor.`,
  [CUSTOM_REGISTER_OFFSETS.BLTBDAT]: `**Blitter source B data register**

This register hold Source x (x=A,B,C) data for use by the Blitter. It is normally loaded by the Blitter DMA channel, however it may also be preloaded by the microprocessor.`,
  [CUSTOM_REGISTER_OFFSETS.BLTADAT]: `**Blitter source A data register**

This register hold Source x (x=A,B,C) data for use by the Blitter. It is normally loaded by the Blitter DMA channel, however it may also be preloaded by the microprocessor.`,
  [CUSTOM_REGISTER_OFFSETS.SPRHDAT]: `**Ext. logic UltraHiRes sprite pointer and data**

This identifies the cycle when this pointer address is on the bus accessing the memory.`,
  [CUSTOM_REGISTER_OFFSETS.BPLHDAT]: `**Ext. logic UHRES bit plane identifier**

This is the number (sign extended) that is added to the UHRES bitplane pointer ([BPLHPTx](/hardware:bplhpth)) every line, and then another 2 is added, just like the other modulos.`,
  [CUSTOM_REGISTER_OFFSETS.LISAID]: `**Denise/Lisa (video out chip) revision level**

The original Denise (8362) does not have this register, so whatever value is left over on the bus from the last cycle will be there. ECS Denise (8373) returns hex (fc) in the lower 8 bits.Lisa returns hex (f8). The upper 8 bits of this Register are loaded from the serial mouse bus, and are reserved for future hardware implentation.The 8 low-order bits are encoded as follows :The 8 low-order bits are encoded as follows :

| Bit| Description  |
|---|---  |
|7-4| Lisa/Denise/ECS Denise Revision level(decrement to bump revision level, hex F represents 0th rev. level).  |
|3| Maintain as a 1 for future generation  |
|2| When low indicates AA feature set (LISA)  |
|1| When low indicates ECS feature set (LISA or ECS DENISE)  |
|0| Maintain as a 1 for future generation|

A proposed way to detect chip's revision through hardware poking :  
      
    
    is_AGA:    move.w 0xdff07c,d0        moveq  #31-1,d2    and.w  #0xff,d0check_loop:    move.w 0xdff07C,d1    and.w  #0xff,d1    cmp.b  d0,d1    bne.b  not_AGA    dbf    d2,check_loop    or.b   #0xf0,d0    cmp.b  #0xf8,d0    bne.b  not_AGA    moveq  #1,d0    rtsnot_AGA:    moveq  #0,d0    rts  
  
---`,
  [CUSTOM_REGISTER_OFFSETS.DSKSYNC]: `**Disk sync register, the match code for disk read synchronization See ADKCON bit 10**`,
  [CUSTOM_REGISTER_OFFSETS.COP1LCH]: `**Coprocessor first location register (high 5 bits) (old-3 bits)**

These registers contain a jump address. See [COPINS](/hardware:copins) for a complete description.`,
  [CUSTOM_REGISTER_OFFSETS.COP1LCL]: `**Coprocessor first location register (low 15 bits)**

These registers contain a jump address. See [COPINS](/hardware:copins) for a complete description.`,
  [CUSTOM_REGISTER_OFFSETS.COP2LCH]: `**Coprocessor second location register (high 5 bits) (old-3 bits)**

These registers contain a jump address. See [COPINS](/hardware:copins) for a complete description.`,
  [CUSTOM_REGISTER_OFFSETS.COP2LCL]: `**Coprocessor second location register (low 15 bits)**

These registers contain a jump address. See [COPINS](/hardware:copins) for a complete description.`,
  [CUSTOM_REGISTER_OFFSETS.COPJMP1]: `**Coprocessor restart at first location**

These address are strobe address, that when written to cause the coprocessor to jump indirect using the address contained in the first or second location regs described below. The coprocessor itself can write to these address, causing it's own jump indirect.`,
  [CUSTOM_REGISTER_OFFSETS.COPJMP2]: `**Coprocessor restart at second location**

These address are strobe address, that when written to cause the coprocessor to jump indirect using the address contained in the first or second location regs described below. The coprocessor itself can write to these address, causing it's own jump indirect.`,
  [CUSTOM_REGISTER_OFFSETS.COPINS]: `**Coprocessor instruction fetch identity**

This is a dummy address that is generated by the coprocessor whenever it is loading instructions into its own instruction register. This actually occurs every coprocessor cycle except for the second (IR2) cycle of the MOVE instruction. The three types of instructions are shown below.

| MOVE| Move immediate to dest  |
|---|---  |
|WAIT| Wait until beam counter is equal to, or greater than. (Keeps coprocessor off of bus until beam position has been reached)  |
|SKIP| Skip if beam counter is equal to, or greater than. (Skips following MOVE inst. unless beam position has been reached)|

| MOVE| WAIT UNTIL| SKIP IF  |
|---|---|---|---  |
|Bit| IR1| IR2| IR1| IR2| IR1| IR2  |
|15| 0| RD15| VP7| BFD| VP7| BFD  |
|14| 0| RD14| VP6| VE6| VP6| VE6  |
|13| 0| RD13| VP5| VE5| VP5| VE5  |
|12| 0| RD12| VP4| VE4| VP4| VE4  |
|11| 0| RD11| VP3| VE3| VP3| VE3  |
|10| 0| RD10| VP2| VE2| VP2| VE2  |
|09| 0| RD09| VP1| VE1| VP1| VE1  |
|08| DA8| RD08| VP0| VE0| VP0| VE0  |
|07| DA7| RD07| HP8| HE8| HP8| HE8  |
|06| DA6| RD06| HP7| HE7| HP7| HE7  |
|05| DA5| RD05| HP6| HE6| HP6| HE6  |
|04| DA4| RD04| HP5| HE5| HP5| HE5  |
|03| DA3| RD03| HP4| HE4| HP4| HE4  |
|02| DA2| RD02| HP3| HE3| HP3| HE3  |
|01| DA1| RD01| HP2| HE2| HP2| HE2  |
|00| 0| RD00| 1| 0| 1| 1|

|IR1| First instruction register  |
|---|---  |
|IR2| Second instruction register  |
|DA| Destination address for MOVE instruction.Fetched during IR1 time,used during IR2 time on RGA bus  |
|RD| RAM Data moved by MOVE instruction at IR2 time directly from RAM to the address given by the DA field  |
|VP| Vertical beam position comparison bit  |
|HP| Horizontal beam position comparison bit  |
|VE| Enable comparison (mask bit)  |
|HE| Enable comparison (mask bit)|

> Note: Note: BFD = Blitter finished disable. When this bit is true, the blitter finished flag will have no effect on the coprocessor. When this bit is zero the blitter finished flag must be true (in addition to the rest of the bit comparisons) before the coprocessor can exit from it's wait state, or skip over an instruction. Note that the V7 comparison cannot be masked.

The coprocessor is basically a 2 cycle machine that requests the bus only during odd memory cycles. (4 memory cycles per in)It has priority over the blitter and microprocessor.It has priority over the blitter and microprocessor.There are only three types of instructions, MOVE immediate, There are only three types of instructions, MOVE immediate, WAIT UNTIL, and SKIP IF. All instructions require 2 bus cycles (and two instruction words). Since only the odd bus cycles are requested, 4 memory cycle times are required per instruction. (memory cycles are 280 ns).There are two indirect jump registers COP1LC and COP2LC. There are two indirect jump registers COP1LC and COP2LC. These are 20 bit pointer registers whose contents are used to modify program counter for initialization or jumps.They are transfered to the program counter whenever strobe address They are transfered to the program counter whenever strobe address COPJMP1 or COPJMP2 are written. In addition COP1LC is automatically used at the beginning of each vertical blank time.It is important that one of the jump registers be initialized and it's It is important that one of the jump registers be initialized and it's jump strobe address hit, after power up but before coprocessor DMA is initialized. This insures a determined startup address, and state.`,
  [CUSTOM_REGISTER_OFFSETS.DIWSTRT]: `**Display window start (upper left vertical-horizontal position)**

These registers control the display window size and position, by locating the upper left and lower right corners.

| Bit| 15| 14| 13| 12| 11| 10| 09| 08| 07| 06| 05| 04| 03| 02| 01| 00  |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---  |
|| V7| V6| V5| V4| V3| V2| V1| V0| H9| H8| H7| H6| H5| H4| H3| H2|

DIWSTRT is vertically restricted to the upper 2/3 of the display (V8=0), and horizontally restricted to the left 3/4 of the display (H8=0).See [DIWHIGH](/hardware:diwhigh) for exceptions.See [DIWHIGH](/hardware:diwhigh) for exceptions.`,
  [CUSTOM_REGISTER_OFFSETS.DIWSTOP]: `**Display window stop (lower right vertical-horizontal position)**

These registers control the display window size and position, by locating the upper left and lower right corners.

| Bit| 15| 14| 13| 12| 11| 10| 09| 08| 07| 06| 05| 04| 03| 02| 01| 00  |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---  |
|| V7| V6| V5| V4| V3| V2| V1| V0| H9| H8| H7| H6| H5| H4| H3| H2|

DIWSTRT is vertically restricted to the upper 2/3 of the display (V8=0), and horizontally restricted to the left 3/4 of the display (H8=0).See [DIWHIGH](/hardware:diwhigh) for exceptions.See [DIWHIGH](/hardware:diwhigh) for exceptions.`,
  [CUSTOM_REGISTER_OFFSETS.DDFSTRT]: `**Display data fetch start (horizontal position)**

These registers control the horizontal timing of the beginning and end of the bit plane DMA timing display data fetch. The vertical bit plane DMA timing is identical to the display windows described above. The bit plane Modulos are dependent on the bit plane horizontal size, and on this data fetch window size.Register bit assignment :Register bit assignment :

| Bit| 15| 14| 13| 12| 11| 10| 09| 08| 07| 06| 05| 04| 03| 02| 01| 00  |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---  |
|| 0| 0| 0| 0| 0| 0| 0| 0| H8| H7| H6| H5| H4| H3| H2| 0|

The tables below show the start and stop timing for different register contentsDDFSTRT (Left edge of display data fetch) :DDFSTRT (Left edge of display data fetch) :

| PURPOSE| H8| H7| H6| H5| H4  |
|---|---|---|---|---|---  |
|Extra wide (max)| 0| 0| 1| 0| 1  |
|wide| 0| 0| 1| 1| 0  |
|normal| 0| 0| 1| 1| 1  |
|narrow| 0| 1| 0| 0| 0|

DDFSTOP (Right edge of display data fetch) :

| PURPOSE| H8| H7| H6| H5| H4  |
|---|---|---|---|---|---  |
|narrow| 1| 1| 0| 0| 1  |
|normal| 1| 1| 0| 1| 0  |
|wide (max)| 1| 1| 0| 1| 1|

Note that these numbers will vary with variable beam counter mode set: (The maxes and mins, that is).`,
  [CUSTOM_REGISTER_OFFSETS.DDFSTOP]: `**Display data fetch stop (horizontal position)**

These registers control the horizontal timing of the beginning and end of the bit plane DMA timing display data fetch. The vertical bit plane DMA timing is identical to the display windows described above. The bit plane Modulos are dependent on the bit plane horizontal size, and on this data fetch window size.Register bit assignment :Register bit assignment :

| Bit| 15| 14| 13| 12| 11| 10| 09| 08| 07| 06| 05| 04| 03| 02| 01| 00  |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---  |
|| 0| 0| 0| 0| 0| 0| 0| 0| H8| H7| H6| H5| H4| H3| H2| 0|

The tables below show the start and stop timing for different register contentsDDFSTRT (Left edge of display data fetch) :DDFSTRT (Left edge of display data fetch) :

| PURPOSE| H8| H7| H6| H5| H4  |
|---|---|---|---|---|---  |
|Extra wide (max)| 0| 0| 1| 0| 1  |
|wide| 0| 0| 1| 1| 0  |
|normal| 0| 0| 1| 1| 1  |
|narrow| 0| 1| 0| 0| 0|

DDFSTOP (Right edge of display data fetch) :

| PURPOSE| H8| H7| H6| H5| H4  |
|---|---|---|---|---|---  |
|narrow| 1| 1| 0| 0| 1  |
|normal| 1| 1| 0| 1| 0  |
|wide (max)| 1| 1| 0| 1| 1|

Note that these numbers will vary with variable beam counter mode set: (The maxes and mins, that is).`,
  [CUSTOM_REGISTER_OFFSETS.DMACON]: `**DMA Control write (clear or set)**

This register controls all of the DMA channels, and contains blitter DMA status bits.

| Bit| Function| Description  |
|---|---|---  |
|15| SET/CLR| Set/Clear control bit. Determines if bits written with a 1 get set or cleared Bits written with a zero are unchanged  |
|14| BBUSY| Blitter busy status bit (read only)  |
|13| BZERO| Blitter logic zero status bit (read only)  |
|12| X|   |
|11| X|   |
|10| BLTPRI| Blitter DMA priority (over CPU micro) (also called "blitter nasty") (disables /BLS pin, preventing micro from stealing any bus cycles while blitter DMA is running)  |
|09| DMAEN| Enable all DMA below (also UHRES DMA)  |
|08| BPLEN| Bit plane DMA enable  |
|07| COPEN| Coprocessor DMA enable  |
|06| BLTEN| Blitter DMA enable  |
|05| SPREN| Sprite DMA enable  |
|04| DSKEN| Disk DMA enable  |
|03| AUD3EN| Audio channel 3 DMA enable  |
|02| AUD2EN| Audio channel 2 DMA enable  |
|01| AUD1EN| Audio channel 1 DMA enable  |
|00| AUD0EN| Audio channel 0 DMA enable|`,
  [CUSTOM_REGISTER_OFFSETS.CLXCON]: `**Collision control**

This register controls which bitplanes are included (enabled) in collision detection, and their required state if included. It also controls the individual inclusion of odd numbered sprites in the collision detection, by logically ORing them with their correspond- ing even numbered sprite. Writing to this register resets the bits in [CLXCON2](/hardware:clxcon2).

| Bit| Function| Description  |
|---|---|---  |
|15| ENSP7| Enable Sprite 7 (ORed with Sprite 6)  |
|14| ENSP5| Enable Sprite 5 (ORed with Sprite 4)  |
|13| ENSP3| Enable Sprite 3 (ORed with Sprite 2)  |
|12| ENSP1| Enable Sprite 1 (ORed with Sprite 0)  |
|11| ENSP6| Enable bit plane 6 (match reqd. for collision)  |
|10| ENSP5| Enable bit plane 5 (match reqd. for collision)  |
|09| ENSP4| Enable bit plane 4 (match reqd. for collision)  |
|08| ENSP3| Enable bit plane 3 (match reqd. for collision)  |
|07| ENSP2| Enable bit plane 2 (match reqd. for collision)  |
|06| ENSP1| Enable bit plane 1 (match reqd. for collision)  |
|05| ENSP6| Match value for bit plane 6 collision  |
|04| ENSP5| Match value for bit plane 5 collision  |
|03| ENSP4| Match value for bit plane 4 collision  |
|02| ENSP3| Match value for bit plane 3 collision  |
|01| ENSP2| Match value for bit plane 2 collision  |
|00| ENSP1| Match value for bit plane 1 collision|`,
  [CUSTOM_REGISTER_OFFSETS.INTENA]: `**Interrupt enable bits (clear or set bits)**

This register contains interrupt enable bits. The bit assignment for both the request, and enable registers is given below.

| Bit| Function| Level| Description  |
|---|---|---|---  |
|15| SET/CLR| | Set/clear control bit. Determines if bits written with a 1 get set or cleared. Bits written with a zero are always unchanged.  |
|14| INTEN| | Master interrupt (enable only, no request)  |
|13| EXTER| 6| External interrupt  |
|12| DSKSYN| 5| Disk sync register (DSKSYNC) matches disk  |
|11| RBF| 5| Serial port receive buffer full  |
|10| AUD3| 4| Audio channel 3 block finished  |
|09| AUD2| 4| Audio channel 2 block finished  |
|08| AUD1| 4| Audio channel 1 block finished  |
|07| AUD0| 4| Audio channel 0 block finished  |
|06| BLIT| 3| Blitter has finished  |
|05| VERTB| 3| Start of vertical blank  |
|04| COPER| 3| Coprocessor  |
|03| PORTS| 2| I/O Ports and timers  |
|02| SOFT| 1| Reserved for software initiated interrupt.  |
|01| DSKBLK| 1| Disk block finished  |
|00| TBE| 1| Serial port transmit buffer empty|`,
  [CUSTOM_REGISTER_OFFSETS.INTREQ]: `**Interrupt request bits (clear or set)**

This register contains interrupt request bits (or flags). These bits may be polled by the processor, and if enabled by the bits listed in the next register, they may cause processor interrupts. Both a set and clear operation are required to load arbitrary data into this register.

| Bit| Function| Level| Description  |
|---|---|---|---  |
|15| SET/CLR| | Set/clear control bit. Determines if bits written with a 1 get set or cleared. Bits written with a zero are always unchanged.  |
|14| INTEN| | Master interrupt (enable only, no request)  |
|13| EXTER| 6| External interrupt  |
|12| DSKSYN| 5| Disk sync register (DSKSYNC) matches disk  |
|11| RBF| 5| Serial port receive buffer full  |
|10| AUD3| 4| Audio channel 3 block finished  |
|09| AUD2| 4| Audio channel 2 block finished  |
|08| AUD1| 4| Audio channel 1 block finished  |
|07| AUD0| 4| Audio channel 0 block finished  |
|06| BLIT| 3| Blitter has finished  |
|05| VERTB| 3| Start of vertical blank  |
|04| COPER| 3| Coprocessor  |
|03| PORTS| 2| I/O Ports and timers  |
|02| SOFT| 1| Reserved for software initiated interrupt.  |
|01| DSKBLK| 1| Disk block finished  |
|00| TBE| 1| Serial port transmit buffer empty|`,
  [CUSTOM_REGISTER_OFFSETS.ADKCON]: `**Audio, Disk, UART Control Write**

|Bit| Function| Description  |
|---|---|---  |
|15| SET/CLEAR| Set/clear control bit.determines if bits written with a 1 get set or cleared.bits written with a zero are always unchanged.  |
|14-13| PRECOMP 1-0| 00 : none 01 : 140 ns 10 : 280 ns 11 : 560 ns  |
|12| MFMPREC| (1 = MFM precomp / 0 = GCR precomp)  |
|11| UARTBRK| Forces a UART break (clears TXD) if true  |
|10| WORDSYNC| Enables disk read synchronizing on a word equal to DISK SYNC CODE, Located in address DSKSYNC (7E).  |
|09| MSBSYNC| Enables disk read synchronizing on the MSB (most significant bit) appl type GCR  |
|08| FAST| Disk data clock rate control : 1 : fast(2us) 0 : slow(4us) (Fast for MFM or 2us,slow for 4us GCR)  |
|07| USE3PN| Use audio channel 3 to modulate nothing  |
|06| USE2P3| Use audio channel 2 to modulate period of channel 3  |
|05| USE1P2| Use audio channel 1 to modulate period of channel 2  |
|04| USE0P1| Use audio channel 0 to modulate period of channel 1  |
|03| USE3VN| Use audio channel 3 to modulate nothing  |
|02| USE2V3| Use audio channel 2 to modulate volume of channel 3  |
|01| USE1V2| Use audio channel 1 to modulate volume of channel 2  |
|00| USE0V1| Use audio channel 0 to modulate volume of channel 1|

> Note: If both period and volume are modulated on the same channel, the period and volume will be alternated. First AUDxDAT word is used for V6-V0 of UDxVOL. Second AUDxDAT word is used for P15-P0 of AUDxPER. This alternating sequence is repeated.`,
  [CUSTOM_REGISTER_OFFSETS.BPLCON0]: `**Bit Plane Control Register 0 (misc, control bits)**

|Bit| Function| Description  |
|---|---|---  |
|15| HIRES| HIRES = High resolution (640*200/640*400 interlace) mode  |
|14-12| BPUx| Bitplane use code 000-110 (NONE through 6 inclusive)  |
|11| HAM| Hold-and-modify mode(1 =Hold-and-modify mode) (0 =Extra Half Brite(EHB) mode,only if 6 bitplanes specified)  |
|10| DPF| Double playfield (PF1 = odd & PF2 = even bit planes) now available in all resolutions. (If BPU = 6 and HAM = 0 and DPF = 0 a special mode is defined that allows bitplane 6 to cause an intensity reduction of the other 5 bitplanes. The color register output selected by 5 bitplanes is shifted to half intensity by the 6th bit plane. This is called EXTRA-HALFBRITE Mode.  |
|09| COLOR| Enables color burst output signal  |
|08| GAUD| Genlock audio enable. This level appears on the ZD pin on denise during all blanking periods, unless ZDCLK bit is set.  |
|07| X UHRES| *[Not in reference manual]* Ultrahi res enables the UHRES pointers (for 1k*1k) also needs bits in DMACON (hires chips only). Disables hard stops for vert, horiz display windows.  |
|06| X SHRES| *[Not in reference manual]* Super hi-res mode (35ns pixel width)  |
|05| X BYPASS=0| *[Not in reference manual]* Bit planes are scrolled and prioritized normally, but bypass color table and 8 bit wide data appear on R(7:0).  |
|04| X BPU3=0| *[Not in reference manual]* See above (BPUx)  |
|03| LPEN| Light pen enable (reset on power up)  |
|02| LACE| Interlace enable (reset on power up)  |
|01| ERSY| External resync (HSYNC, VSYNC pads become inputs) (reset on power up)  |
|00| X ECSENA=0| *[Not in reference manual]* When low (default), the following bits in BPLCON3 are disabled: BRDRBLNK,BRDNTRAN,ZDCLKEN,BRDSPRT, and EXTBLKEN. These 5 bits can always be set by writing to BPLCON3, however there effects are inhibited until ECSENA goes high. This allows rapid context switching between pre-ECS viewports and new ones.|`,
  [CUSTOM_REGISTER_OFFSETS.BPLCON1]: `**Bit Plane Control Register (horizontal, scroll counter)**

|Bit| Function| Description  |
|---|---|---  |
|15| X PF2H7| *[Not in reference manual]* (PF2Hx =) Playfield 2 horizontal scroll code, x=0-7  |
|14| X PF2H6| *[Not in reference manual]*  |
|13| X PF2H1| *[Not in reference manual]*  |
|12| X PF2H0| *[Not in reference manual]*  |
|11| X PF1H7| *[Not in reference manual]* (PF1Hx =) Playfield 1 horizontal scroll code, x=0-7 where PFyH0 = LSB = 35ns SHRES pixel (bits have been renamed, old PFyH0 now PFyH2, etc). Now that the scroll range has been quadrupled to allow for wider (32 or 64 bits) bitplanes.  |
|10| X PF1H6| *[Not in reference manual]*  |
|09| X PF1H1| *[Not in reference manual]*  |
|08| X PF1H0| *[Not in reference manual]*  |
|07| PF2H5| OCS/ECS  |
|06| PF2H4| "  |
|05| PF2H3| "  |
|04| PF2H2| "  |
|03| PF1H5| "  |
|02| PF1H4| "  |
|01| PF1H3| "  |
|00| PF1H2| "|`,
  [CUSTOM_REGISTER_OFFSETS.BPLCON2]: `**Bit Plane Control Register (new control bits)**

|Bit| Function| Description  |
|---|---|---  |
|15| X | *[Not in reference manual]* don't care- but drive to 0 for upward compatibility  |
|14| X ZDBPSEL2| *[Not in reference manual]* 3 bit field which selects which bitplane is to be used for ZD when ZDBBPEN is set- 000 selects BB1 and 111 selects BP8.  |
|13| X ZDBPSEL1| *[Not in reference manual]*  |
|12| X ZDBPSEL0| *[Not in reference manual]*  |
|11| X ZDBPEN| *[Not in reference manual]* Causes ZD pin to mirror bitplane selected by ZDBPSELx bits. This does not disable the ZD mode defined by ZDCTEN, but rather is "ored" with it.  |
|10| X ZDCTEN| *[Not in reference manual]* Causes ZD pin to mirror bit #15 of the active entry in high color table. When ZDCTEN is reset ZD reverts to mirroring color (0).  |
|09| X KILLEHB| *[Not in reference manual]* Disables extra halfbrite mode.  |
|08| X RDRAM=0| *[Not in reference manual]* Causes color table address to read the color table instead of writing to it.  |
|07| X SOGEN=0| *[Not in reference manual]* When set causes SOG output pin to go high  |
|06| PF2PRI| Gives playfield 2 priority over playfield 1.  |
|05| PF2P2| Playfield 2 priority code (with resp. to sprites).  |
|04| PF2P1|   |
|03| PF2P0|   |
|02| PF1P2| Playfield 1 priority code (with resp. to sprites).  |
|01| PF1P1|   |
|00| PF1P0||`,
  [CUSTOM_REGISTER_OFFSETS.BPLCON3]: `**Bit Plane Control Register (enhanced bits)**

|Bit| Function| Description  |
|---|---|---  |
|15-13| BANKx| Selects one of eight color banks, x = 0-2.  |
|12-10| PF2OFx| Determine bit plane color table offset when playfield 2 has priority in dual playfield mode : 000 : none 001 : 2 (plane 2 affected) 010 : 4 (plane 3 affected) 011 : 8 (plane 3 affected) (default) 100 : 16 (plane 5 affected) 101 : 32 (plane 6 affected) 110 : 64 (plane 7 affected) 111 : 128 (plane 8 affected)  |
|09| LOCT=0| Dictates that subsequent color palette values will be written to a second 12-bit color palette, constituting the RGB low minus order bits. Writes to the normal hi minus order color palette automattically copied to the low order for backwards compatibility.  |
|08| x| Don't care but drive to 0 for upward compatibility  |
|07-06| SPRESx=0| Determine resolution of all 8 sprites (x = 0,1): 00 : ECS defaults (LORES, HIRES=140ns, SHRES=70ns) 01 : LORES (140ns) 10 : HIRES (70ns) 11 : SHRES (35ns)  |
|05| BRDRBLNK=0| "Border area" is blanked instead of color (0). Disabled when ECSENA low.  |
|04| BRDNTRAN=0| "Border area" is non minus transparant (ZD pin is low when border is displayed). Disabled when ECSENA low.  |
|03| x| Don't care but drive to 0 for upward compatibility  |
|02| ZDCLKEN=0| ZD pin outputs a 14MHz clock whose falling edge coincides with hires (7MHz) video data. this bit when set disables all other ZD functions. Disabled when ESCENA low.  |
|01| BRDSPRT=0| Enables sprites outside the display window. disabled when ESCENA low.  |
|00| EXTBLKEN=0| Causes BLANK output to be programmable instead of reflecting internal fixed decodes. Disabled when ESCENA low.|`,
  [CUSTOM_REGISTER_OFFSETS.BPL1MOD]: `**Bit plane modulo (odd planes)**

These registers contain the modulos for the odd and even bit planes. A modulo is a number that is automatically added to the address at the end of each line, in order that the address then points to the start of the next line. Since they have separate modulos, the odd and even bit planes may have sizes that are different from each other, as well as different from the display window size.If scan-doubling is enabled, BPL1MOD serves as the primary bitplane If scan-doubling is enabled, BPL1MOD serves as the primary bitplane modulos and BPL2MOD serves as the alternate. Lines whose LSBs of beam counter and DIWSTRT match are designated primary, whereas lines whose LSBs don't match are designated alternate.`,
  [CUSTOM_REGISTER_OFFSETS.BPL2MOD]: `**Bit plane modulo (even planes)**

These registers contain the modulos for the odd and even bit planes. A modulo is a number that is automatically added to the address at the end of each line, in order that the address then points to the start of the next line. Since they have separate modulos, the odd and even bit planes may have sizes that are different from each other, as well as different from the display window size.If scan-doubling is enabled, BPL1MOD serves as the primary bitplane If scan-doubling is enabled, BPL1MOD serves as the primary bitplane modulos and BPL2MOD serves as the alternate. Lines whose LSBs of beam counter and DIWSTRT match are designated primary, whereas lines whose LSBs don't match are designated alternate.`,
  [CUSTOM_REGISTER_OFFSETS.BPLCON4]: `**Bit Plane Control Register (display masks)**

|Bit| Function| Description  |
|---|---|---  |
|15-08| BPLAMx=0| This 8 bit field is XOR'ed with the 8 bit plane color address, thereby altering the color address sent to the color table. Default value is 00000000 binary. (x=0-7)  |
|07-04| ESPRMx=1| 4 Bit field provides the 4 high order color table address bits for even sprites: SPR0,SPR2,SPR4,SPR6. Default value is 0001 binary. (x=7-4)  |
|03-00| OSPRM7=1| 4 Bit field provides the 4 high order color table address bits for odd sprites: SPR1,SPR3,SPR5,SPR7. Default value is 0001 binary. (x=7-4)|`,
  [CUSTOM_REGISTER_OFFSETS.CLXCON2]: `**Extended Collision Control**

This reg controls when bit planes 7 and 8 are included in collision detection, and there required state if included. Contents of this register are reset by a write to [CLXCON](/hardware:clxcon). ***BITS INITIALIZED BY RESET** * ***BITS INITIALIZED BY RESET** *

| Bit| Function| Description  |
|---|---|---  |
|15-08| | Unused  |
|07| ENBP8| Enable bit plane 8 (match reqd. for collision)  |
|06| ENBP7| Enable bit plane 7 (match reqd. for collision)  |
|05-02| | Unused  |
|01| MVBP8| Match value for bit plane 8 collision  |
|00| MVBP7| Match value for bit plane 7 collision|

> Note: Disable bit planes cannot prevent collisions. Therefore if all bitplanes are disabled, collision will be continuous, regardless of the match values.`,
  [CUSTOM_REGISTER_OFFSETS.HTOTAL]: `**Highest colour clock count in horizontal line**

|Bit| 15| 14| 13| 12| 11| 10| 09| 08| 07| 06| 05| 04| 03| 02| 01| 00  |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---  |
|| 0| 0| 0| 0| 0| 0| 0| 0| H8| H7| H6| H5| H4| H3| H2| H1|

Horizontal line has these many + 1 280nS increments. If the pal bit & LOLDIS are not high, long line/short line toggle will occur, and there will be this many +2 every other line. Active if VARBEAMEN=1 or DUAL+1.`,
  [CUSTOM_REGISTER_OFFSETS.HSSTOP]: `**Horizontal line position for SYNC stop**

Sets # of colour clocks for sync stop ([HTOTAL](/hardware:htotal) for bits).`,
  [CUSTOM_REGISTER_OFFSETS.HBSTRT]: `**Horizontal START position**

Bits 7-0 contain the stop and start positions, respectively, for programmed horizontal blanking in 280ns increments. Bits 10-8 provide a fine position control in 35ns increments.

| Bit| Function| Description  |
|---|---|---  |
|15-11| 0| Unused  |
|10| H1| 140ns  |
|09| H1| 70ns  |
|08| H0| 35ns  |
|07| H10| 35840ns  |
|06| H9| 17920ns  |
|05| H8| 8960ns  |
|04| H7| 4480ns  |
|03| H6| 2240ns  |
|02| H5| 1120ns  |
|01| H4| 560ns  |
|00| H3| 280ns|`,
  [CUSTOM_REGISTER_OFFSETS.HBSTOP]: `**Horizontal STOP position**

Bits 7-0 contain the stop and start positions, respectively, for programmed horizontal blanking in 280ns increments. Bits 10-8 provide a fine position control in 35ns increments.

| Bit| Function| Description  |
|---|---|---  |
|15-11| 0| Unused  |
|10| H1| 140ns  |
|09| H1| 70ns  |
|08| H0| 35ns  |
|07| H10| 35840ns  |
|06| H9| 17920ns  |
|05| H8| 8960ns  |
|04| H7| 4480ns  |
|03| H6| 2240ns  |
|02| H5| 1120ns  |
|01| H4| 560ns  |
|00| H3| 280ns|`,
  [CUSTOM_REGISTER_OFFSETS.VTOTAL]: `**Highest numbered vertical line (VERBEAMEN = 1)**

It's the line number to reset the counter, so there's this many + 1 in a field. The exception is if the LACE bit is set ([BPLCON0](/hardware:bplcon0)), in which case every other field is this many + 2 and the short field is this many + 1.`,
  [CUSTOM_REGISTER_OFFSETS.VSSTOP]: `**Vertical position for VSYNC stop**

It's the line number to reset the counter, so there's this many + 1 in a field. The exception is if the LACE bit is set ([BPLCON0](/hardware:bplcon0)), in which case every other field is this many + 2 and the short field is this many + 1.`,
  [CUSTOM_REGISTER_OFFSETS.VBSTRT]: `**Vertical line for VBLANK start**

(V10-0 <\\- D10-0) Affects CSY pin if BLAKEN=1 and VSY pin if CSCBEN=1 (see [BEAMCON0](/hardware:beamcon0))`,
  [CUSTOM_REGISTER_OFFSETS.VBSTOP]: `**Vertical line for VBLANK stop**

(V10-0 <\\- D10-0) Affects CSY pin if BLAKEN=1 and VSY pin if CSCBEN=1 (see [BEAMCON0](/hardware:beamcon0))`,
  [CUSTOM_REGISTER_OFFSETS.SPRHSTRT]: `**UHRES sprite vertical display start**

|Bit| 15| 14| 13| 12| 11| 10| 09| 08| 07| 06| 05| 04| 03| 02| 01| 00  |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---  |
|| 0| 0| 0| 0| 0| V10| V9| V8| V7| V6| V5| V4| V3| V2| V1| V0|`,
  [CUSTOM_REGISTER_OFFSETS.SPRHSTOP]: `**UHRES sprite vertical display stop**

|Bit| 15| 14| 13| 12| 11| 10| 09| 08| 07| 06| 05| 04| 03| 02| 01| 00  |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---  |
||SPRHWRM| 0| 0| 0| 0| 0| V10| V9| V8| V7| V6| V5| V4| V3| V2| V1| V0|

SPRHWRM = Swaps the polarity of ARW* when the SPRHDAT comes out so that external devices can detect the RGA and put things into memory. (ECS and later chips only)`,
  [CUSTOM_REGISTER_OFFSETS.BPLHSTRT]: `**UHRES bit plane vertical stop**

This controls the line when the data fetch starts for the [BPLHPTx](/hardware:bplhpth) pointers. V10-V0 on DB10-0.`,
  [CUSTOM_REGISTER_OFFSETS.BPLHSTOP]: `**UHRES bit plane vertical stop**

|Bit| Name  |
|---|---  |
|15| BPLHWRM  |
|14-11| Unused  |
|10-0| V10-V0|

BPLHWRM = Swaps the polarity of ARW* when the BPLHDAT comes out so that external devices can detect the RGA and put things into memory (ECS and later versions).`,
  [CUSTOM_REGISTER_OFFSETS.HHPOSW]: `**DUAL mode hires Hbeam counter write**

This the secondary beam counter for the faster mode, triggering the UHRES pointers & doing the comparisons for [HBSTRT](/hardware:hbstrt), [HBSTOP](/hardware:hbstrt), [HTOTAL](/hardware:htotal), [HSSTRT](/hardware:hsstrt), [HSSTOP](/hardware:hsstop) (See [HTOTAL](/hardware:htotal) for bits)`,
  [CUSTOM_REGISTER_OFFSETS.HHPOSR]: `**DUAL mode hires Hbeam counter read**

This the secondary beam counter for the faster mode, triggering the UHRES pointers & doing the comparisons for [HBSTRT](/hardware:hbstrt), [HBSTOP](/hardware:hbstrt), [HTOTAL](/hardware:htotal), [HSSTRT](/hardware:hsstrt), [HSSTOP](/hardware:hsstop) (See [HTOTAL](/hardware:htotal) for bits)`,
  [CUSTOM_REGISTER_OFFSETS.BEAMCON0]: `**Beam Counter Control Bits**

|Bit| Function  |
|---|---  |
|15| Unused  |
|14| HARDDIS  |
|13| LPENDIS  |
|12| VARVBEN  |
|11| LOLDIS  |
|10| CSCBEN  |
|9| VARVSYEN  |
|8| VARHSYEN  |
|7| VARBEAMEN  |
|6| DUAL  |
|5| PAL  |
|4| VARCSYEN  |
|3| (unused, formerly BLANKEN)  |
|2| CSYTRUE  |
|1| VSYTRUE  |
|0| HSYTRUE|

**HARDDIS** This bit is used to disable the hardwired vertical horizontal window limits. It is cleared upon reset. **LPENDIS** **LPENDIS** When this bit is a low and LPE ([BPLCON0](/hardware:bplcon0), bit 3) is enabled, the light-pen latched value(beam hit position) will be read by [VHPOSR](/hardware:vhposr), [VPOSR](/hardware:vposr) and [HHPOSR](/hardware:hhposw). When the bit is a high the light-pen latched value is ignored and the actual beam counter position is read by [VHPOSR](/hardware:vhposr), [VPOSR](/hardware:vposr), and [HHPOSR](/hardware:hhposw). **VARVBEN** **VARVBEN** Use the comparator generated vertical blank (from [VBSTRT](/hardware:vbstrt), [VBSTOP](/hardware:vbstrt)) to run the internal chip stuff-sending RGA signals to Denise, starting sprites,resetting light pen. It also disables the hard stop on the vertical display window. **LOLDIS** **LOLDIS** Disable long line/short toggle. This is useful for DUAL mode where even multiples are wanted, or in any single display where this toggling is not desired. **CSCBEN** **CSCBEN** The variable composite sync comes out on the HSY pin, and the variable composite blank comes out on the VSY pin. The idea is to allow all the information to come out of the chip for a DUAL mode display. The normal monitor uses the normal composite sync, and the variable composite sync  &blank come out the HSY & VSY pins. The bits VARVSTEN & VARHSYEN (below) have priority over this control bit. **VARVSYEN** **VARVSYEN** Comparator VSY - > VSY pin. The variable VSY is set vertically on [VSSTRT](/hardware:vsstrt), reset vertically on [VSSTOP](/hardware:vtotal), with the horizontal position for set set & reset [HSSTRT](/hardware:hsstrt) on short fields (all fields are short if LACE = 0) and [HCENTER](/hardware:hcenter) on long fields (every other field if LACE = 1). **VARHSYEN** **VARHSYEN** Comparator HSY - > HSY pin. Set on [HSSTRT](/hardware:hsstrt) value, reset on [HSSTOP](/hardware:hsstrt) value. **VARBEAMEN** **VARBEAMEN** Enables the variable beam counter comparators to operate (allowing different beam counter total values) on the main horiz counter. It also disables hard display stops on both horizontal and vertical. **DUAL** **DUAL** Run the horizontal comparators with the alternate horizontal beam counter, and starts the UHRES pointer chain with the reset of this counter rather than the normal one. This allows the UHRES pointers to come out more than once in a horizontal line, assuming there is some memory bandwidth left (it doesn't work in 640*400*4 interlace mode) also, to keep the two displays synced, the horizontal line lengths should be multiples of each other. If you are amazingly clever, you might not need to do this. **PAL** **PAL** Set appropriate decodes (in normal mode) for PAL. In variable beam counter mode this bit disables the long line/short line toggle- ends up short line. **VARCSYEN** **VARCSYEN** Enables CSY from the variable decoders to come out the CSY (VARCSY is set on [HSSTRT](/hardware:hsstrt) match always, and also on [HCENTER](/hardware:hcenter) match when in vertical sync. It is reset on [HSSTOP](/hardware:hsstop) match when VSY and on both [HBSTRT](/hardware:hbstrt) & [HBSTOP](/hardware:hbstrt) matches during VSY. A reasonable composite can be generated by setting [HCENTER](/hardware:hcenter) half a horizontal line from [HSSTRT](/hardware:hsstrt), and [HBSTOP](/hardware:hbstrt) at ([HSSTOP](/hardware:hsstop)-[HSSTRT](/hardware:hsstrt)) before [HCENTER](/hardware:hcenter), with [HBSTRT](/hardware:hbstrt) at ( [HSSTOP](/hardware:hsstop)-[HSSTRT](/hardware:hsstrt)) before [HSSTRT](/hardware:hsstrt). **HSYTRUE, VSYTRUE, CSYTRUE** **HSYTRUE, VSYTRUE, CSYTRUE** These change the polarity of the HSY*, VSY*,  & CSY* pins to HSY, VSY, & CSY respectively for input and output.`,
  [CUSTOM_REGISTER_OFFSETS.HSSTRT]: `**Horiz line position for HSYNC stop**

Set # of colour clocks for sync start ([HTOTAL](/hardware:htotal) for bits) See [BEAMCON0](/hardware:beamcon0) for details of when these 2 are active.`,
  [CUSTOM_REGISTER_OFFSETS.VSSTRT]: `**Vertical sync start (VARVSY)**`,
  [CUSTOM_REGISTER_OFFSETS.HCENTER]: `**Horizontal position (CCKs) of VSYNC on long field**

This is necessary for interlace mode with variable beam counters. See [BEAMCON0](/hardware:beamcon0) for when it affects chip outputs. See [HTOTAL](/hardware:htotal) for bits.`,
  [CUSTOM_REGISTER_OFFSETS.DIWHIGH]: `**Display window upper bits for start, stop**

This is an added register for Hires chips, and allows larger start & stop ranges. If it is not written, ([DIWSTRT](/hardware:diwstrt), [DIWSTOP](/hardware:diwstrt)) description holds. If this register is written, direct start & stop positions anywhere on the screen. It doesn't affect the UHRES pointers.

| Bit| 15| 14| 13| 12| 11| 10| 09| 08| 07| 06| 05| 04| 03| 02| 01| 00  |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---  |
|| 0| 0| H10| H1| H0| V10| V9| V8| 0| 0| H10| H1| H0| V10| V9| V8  |
|| (stop)| (start)|

H1 and H0 values define 70ns and 35ns increments respectively, and new LISA bits.  
  
> Note: In all 3 display window registers, horizontal bit positions have been renamed to reflect HIRES pixel increments, e.g. what used to be called H0 is now referred to as H2.`,
  [CUSTOM_REGISTER_OFFSETS.BPLHMOD]: `**UHRES bit plane modulo**

This is the number (sign extended) that is added to the UHRES bitplane pointer ([BPLHPTx](/hardware:bplhpth)) every line, and then another 2 is added, just like the other modulos.`,
  [CUSTOM_REGISTER_OFFSETS.SPRHPTH]: `**UHRES sprite pointer (high 5 bits)**

This pointer is activated in the 1st and 3rd 'free' cycles (see [BPLHPTx](/hardware:bplhpth)) after horizontal line start. It increments for the next line.`,
  [CUSTOM_REGISTER_OFFSETS.SPRHPTL]: `**UHRES sprite pointer (low 15 bits)**

This pointer is activated in the 1st and 3rd 'free' cycles (see [BPLHPTx](/hardware:bplhpth)) after horizontal line start. It increments for the next line.`,
  [CUSTOM_REGISTER_OFFSETS.BPLHPTH]: `**UHRES (VRAM) bit plane pointer (high 5 bits)**

When UHRES is enabled, this pointer comes out on the 2nd 'free' cycle after the start of each horizontal line. It‘s modulo is added every time it comes out. ’free' means priority above the copper and below the fixed stuff (audio,sprites….). [BPLHDAT](/hardware:bplhmod) comes out as an identifier on the RGA lines when the pointer address is valid so that external detectors can use this to do the special cycle for the VRAMs, The [SPRHDAT](/hardware:sprhdat) gets the first and third free cycles.`,
  [CUSTOM_REGISTER_OFFSETS.BPLHPTL]: `**UHRES (VRAM) bit plane pointer (low 15 bits)**

When UHRES is enabled, this pointer comes out on the 2nd 'free' cycle after the start of each horizontal line. It‘s modulo is added every time it comes out. ’free' means priority above the copper and below the fixed stuff (audio,sprites….). [BPLHDAT](/hardware:bplhmod) comes out as an identifier on the RGA lines when the pointer address is valid so that external detectors can use this to do the special cycle for the VRAMs, The [SPRHDAT](/hardware:sprhdat) gets the first and third free cycles.`,
  [CUSTOM_REGISTER_OFFSETS.FMODE]: `**Memory Fetch Mode**

This register controls the fetch mechanism for different types of Chip RAM accesses:

| Bit| Function| Description  |
|---|---|---  |
|15| SSCAN2| Global enable for sprite scan-doubling.  |
|14| BSCAN2| Enables the use of 2nd P/F modulus on an alternate line basis to support bitplane scan-doubling.  |
|13-04| Unused|   |
|03| SPAGEM| Sprite page mode (double CAS)  |
|02| SPR32| Sprite 32 bit wide mode  |
|01| BPAGEM| Bitplane Page Mode (double CAS)  |
|00| BLP32| Bitplane 32 bit wide mode|

|BPAGEM| BPL32| Bitplane Fetch| Increment| Memory Cycle| Bus Width  |
|---|---|---|---|---|---  |
|0| 0| By 2 bytes| (as before)| normal CAS| 16  |
|0| 1| By 4 bytes| | normal CAS| 32  |
|1| 0| By 4 bytes| | double CAS| 16  |
|1| 1| By 8 bytes| | double CAS| 32|

|SPAGEM| SPR32| Sprite Fetch| Increment| Memory Cycle| Bus Width  |
|---|---|---|---|---|---  |
|0| 0| By 2 bytes| (as before)| normal CAS| 16  |
|0| 1| By 4 bytes| | normal CAS| 32  |
|1| 0| By 4 bytes| | double CAS| 16  |
|1| 1| By 8 bytes| | double CAS| 32|`,
};

// ── family expansion: generate each variant's heading, reference the shared body ──
// COLOR00..COLOR31
for (let i = 0; i < 32; i++) customRegisterDocs[CUSTOM_REGISTER_OFFSETS.COLOR00 + i * 2] = doc(`Color ${i}`, BODY_COLOR);
// Bitplane pointers (BPL1..8, high/low)
for (let p = 1; p <= 8; p++) {
  customRegisterDocs[CUSTOM_REGISTER_OFFSETS.BPL1PTH + (p - 1) * 4] = doc(`Bit plane ${p} pointer (high 5 bits)`, BODY_BPLPTR);
  customRegisterDocs[CUSTOM_REGISTER_OFFSETS.BPL1PTL + (p - 1) * 4] = doc(`Bit plane ${p} pointer (low 15 bits)`, BODY_BPLPTR);
}
// Bitplane data (BPL1..8)
for (let p = 1; p <= 8; p++) customRegisterDocs[CUSTOM_REGISTER_OFFSETS.BPL1DAT + (p - 1) * 2] = doc(`Bit plane ${p} data (parallel to serial convert)`, BODY_BPLDAT);
// Sprite pointers (SPR0..7, high/low)
for (let s = 0; s < 8; s++) {
  customRegisterDocs[CUSTOM_REGISTER_OFFSETS.SPR0PTH + s * 4] = doc(`Sprite ${s} pointer (high 5 bits)`, BODY_SPRPTR);
  customRegisterDocs[CUSTOM_REGISTER_OFFSETS.SPR0PTL + s * 4] = doc(`Sprite ${s} pointer (low 15 bits)`, BODY_SPRPTR);
}
// Sprite position / control / image data (SPR0..7); DATA & DATB share BODY_SPRDAT
for (let s = 0; s < 8; s++) {
  customRegisterDocs[CUSTOM_REGISTER_OFFSETS.SPR0POS + s * 8] = doc(`Sprite ${s} vertical & horizontal start positions data`, BODY_SPRPOS);
  customRegisterDocs[CUSTOM_REGISTER_OFFSETS.SPR0CTL + s * 8] = doc(`Sprite ${s} position and control data`, BODY_SPRCTL);
  customRegisterDocs[CUSTOM_REGISTER_OFFSETS.SPR0DATA + s * 8] = doc(`Sprite ${s} image data register A`, BODY_SPRDAT);
  customRegisterDocs[CUSTOM_REGISTER_OFFSETS.SPR0DATB + s * 8] = doc(`Sprite ${s} image data register B`, BODY_SPRDAT);
}
// Audio channels (AUD0..3); LCH & LCL share BODY_AUDLOC
for (let ch = 0; ch < 4; ch++) {
  customRegisterDocs[CUSTOM_REGISTER_OFFSETS.AUD0LCH + ch * 0x10] = doc(`Audio Channel ${ch} Location (high 5 bits)`, BODY_AUDLOC);
  customRegisterDocs[CUSTOM_REGISTER_OFFSETS.AUD0LCL + ch * 0x10] = doc(`Audio Channel ${ch} Location (low 15 bits)`, BODY_AUDLOC);
  customRegisterDocs[CUSTOM_REGISTER_OFFSETS.AUD0LEN + ch * 0x10] = doc(`Audio Channel ${ch} Length`, BODY_AUDLEN);
  customRegisterDocs[CUSTOM_REGISTER_OFFSETS.AUD0PER + ch * 0x10] = doc(`Audio Channel ${ch} Period`, BODY_AUDPER);
  customRegisterDocs[CUSTOM_REGISTER_OFFSETS.AUD0VOL + ch * 0x10] = doc(`Audio Channel ${ch} Volume`, BODY_AUDVOL);
  customRegisterDocs[CUSTOM_REGISTER_OFFSETS.AUD0DAT + ch * 0x10] = doc(`Audio Channel ${ch} Data`, BODY_AUDDAT);
}

// Documentation for a custom-register offset (0x000-0x1FE), or undefined if undocumented.
export function getCustomRegDoc(offset: number): string | undefined {
  return customRegisterDocs[offset & 0x1fe];
}
