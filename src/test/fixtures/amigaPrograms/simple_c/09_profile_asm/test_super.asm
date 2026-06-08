USE_SUPERVISOR = 1

_start:
        lea     $dff000,a6
        move.w  #$7fff,d0 ; all off
        move.w  d0,$96(a6) ; dmacon
        move.w  d0,$9a(a6) ; intena

        ifne USE_SUPERVISOR
        ; enter supervisor mode
        lea     .trap(pc),a5
        move.l  a5,$80.w
        trap    #0
.trap:
        endc

        ; Install L2 interrupt
        lea     L2int(pc),a0
        move.l  a0,$6c.w

        ; Enable vblank interrupt
        move.w  #(1<<15)+(1<<14)+(1<<5),$9a(a6) ; intena

.mainLoop
        bsr     PokeCols
        bsr     WaitEOF
        bra     .mainLoop

L2int:
        movem.l d0-a6,-(sp)

        bsr     PokeCols

        move.w  #1<<5,$9c(a6) ; VERTB intreq
        movem.l (sp)+,d0-a6
        rte

PokeCols:
        move.w  #$400,d7
.l      move.w  d7,$180(a6)
        dbf     d7,.l
        rts

WaitEOF:
        move.w  #$138,d0
.wait:  move.l  4(a6),d1
        lsr.l   #1,d1
        lsr.w   #7,d1
        cmp.w   d0,d1
        bne.s   .wait
        rts
		