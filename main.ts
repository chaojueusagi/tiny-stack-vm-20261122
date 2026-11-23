// Tiny stack VM for make.fun tiny-stack-vm-01-run-20261122.
// From-scratch interpreter of the ISA in generator/subject/ISA.md.
// Node 22, standard library only, deterministic.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Immediate length + 1 per opcode (0 = not an opcode). Only 0x01, 0x02
// and 0x30..0x33 take an immediate; every other opcode takes none.
const IM = new Uint8Array(256);
for (const o of [
  0x00, 0x03, 0x04, 0x05, 0x06, 0x07, 0x10, 0x11, 0x12, 0x13, 0x14, 0x15,
  0x16, 0x17, 0x18, 0x19, 0x1a, 0x1b, 0x1c, 0x1d, 0x1e, 0x20, 0x21, 0x22,
  0x34, 0x40, 0x41, 0x50, 0x51, 0x52, 0x53,
]) IM[o] = 1;
IM[0x01] = 2; IM[0x02] = 5;
IM[0x30] = 3; IM[0x31] = 3; IM[0x32] = 3; IM[0x33] = 3;

function run(p: Uint8Array, inp: Uint8Array): [Uint8Array, number] {
  const D = new Int32Array(256);
  const C = new Int32Array(64);
  const M = new Int32Array(256);
  const out = new Uint8Array(65536);
  let sp = 0, cp = 0, pc = 0, ip = 0, ol = 0, steps = 0;
  const n = p.length;
  const done = (code: number): [Uint8Array, number] => [out.subarray(0, ol), code];
  for (;;) {
    if (steps === 1000000) return done(10); // step limit
    if (pc < 0 || pc >= n) return done(9); // pc outside the program
    const op = p[pc];
    const im1 = IM[op];
    if (im1 === 0) return done(5); // unknown opcode
    const imm = im1 - 1;
    if (pc + imm >= n) return done(9); // immediate cut off by the end
    steps++;
    const nx = pc + 1 + imm;
    pc = nx;
    switch (op) {
      case 0x00: return done(0); // HALT
      case 0x01: // PUSH8, sign-extended
        if (sp === 256) return done(3);
        D[sp++] = (p[nx - 1] << 24) >> 24;
        break;
      case 0x02: // PUSH32, little-endian
        if (sp === 256) return done(3);
        D[sp++] = p[nx - 4] | (p[nx - 3] << 8) | (p[nx - 2] << 16) | (p[nx - 1] << 24);
        break;
      case 0x03: // POP
        if (sp < 1) return done(2);
        sp--;
        break;
      case 0x04: // DUP
        if (sp < 1) return done(2);
        if (sp === 256) return done(3);
        D[sp] = D[sp - 1];
        sp++;
        break;
      case 0x05: // SWAP
        if (sp < 2) return done(2);
        { const t = D[sp - 1]; D[sp - 1] = D[sp - 2]; D[sp - 2] = t; }
        break;
      case 0x06: // OVER
        if (sp < 2) return done(2);
        if (sp === 256) return done(3);
        D[sp] = D[sp - 2];
        sp++;
        break;
      case 0x07: // ROT: (a b c -- b c a)
        if (sp < 3) return done(2);
        { const a = D[sp - 3]; D[sp - 3] = D[sp - 2]; D[sp - 2] = D[sp - 1]; D[sp - 1] = a; }
        break;
      case 0x17: // NEG, wraps: -(-2147483648) is -2147483648
        if (sp < 1) return done(2);
        D[sp - 1] = -D[sp - 1] | 0;
        break;
      case 0x1b: // NOT
        if (sp < 1) return done(2);
        D[sp - 1] = ~D[sp - 1];
        break;
      case 0x10: case 0x11: case 0x12: case 0x13: case 0x14: case 0x15: case 0x16:
      case 0x18: case 0x19: case 0x1a: case 0x1c: case 0x1d: case 0x1e:
      case 0x20: case 0x21: case 0x22: {
        if (sp < 2) return done(2);
        const b = D[sp - 1], a = D[sp - 2];
        let r: number;
        if (op === 0x10) r = (a + b) | 0;
        else if (op === 0x11) r = (a - b) | 0;
        else if (op === 0x12) r = Math.imul(a, b); // low 32 bits, exact
        else if (op === 0x13) { // DIV, signed, truncates toward zero
          if (b === 0) return done(4);
          r = a === -2147483648 && b === -1 ? a : (a / b) | 0;
        } else if (op === 0x14) { // MOD, sign of a; x % -1 is 0
          if (b === 0) return done(4);
          r = b === -1 ? 0 : (a % b) | 0;
        } else if (op === 0x15) { // DIVU, unsigned
          if (b === 0) return done(4);
          r = Math.floor((a >>> 0) / (b >>> 0)) | 0;
        } else if (op === 0x16) { // MODU, unsigned
          if (b === 0) return done(4);
          r = ((a >>> 0) % (b >>> 0)) | 0;
        } else if (op === 0x18) r = a & b;
        else if (op === 0x19) r = a | b;
        else if (op === 0x1a) r = a ^ b;
        else if (op === 0x1c) r = a << (b & 31);
        else if (op === 0x1d) r = a >> (b & 31);
        else if (op === 0x1e) r = (a >>> (b & 31)) | 0;
        else if (op === 0x20) r = a === b ? 1 : 0;
        else if (op === 0x21) r = a < b ? 1 : 0;
        else r = (a >>> 0) < (b >>> 0) ? 1 : 0; // LTU
        sp -= 2;
        D[sp++] = r;
        break;
      }
      case 0x30: case 0x31: case 0x32: { // JMP / JZ / JNZ
        const rel = ((p[nx - 2] | (p[nx - 1] << 8)) << 16) >> 16;
        if (op === 0x30) { pc = nx + rel; break; }
        if (sp < 1) return done(2);
        const v = D[--sp];
        if ((op === 0x31) === (v === 0)) pc = nx + rel;
        break;
      }
      case 0x33: // CALL, absolute 16-bit address
        if (cp === 64) return done(7);
        C[cp++] = nx;
        pc = p[nx - 2] | (p[nx - 1] << 8);
        break;
      case 0x34: // RET
        if (cp === 0) return done(8);
        pc = C[--cp];
        break;
      case 0x40: // LOAD
        if (sp < 1) return done(2);
        {
          const addr = D[sp - 1];
          if (addr < 0 || addr >= 256) return done(6);
          D[sp - 1] = M[addr];
        }
        break;
      case 0x41: // STORE: (v addr --), top of stack is the address
        if (sp < 2) return done(2);
        {
          const addr = D[sp - 1], v = D[sp - 2];
          if (addr < 0 || addr >= 256) return done(6);
          sp -= 2;
          M[addr] = v;
        }
        break;
      case 0x50: { // PRINT: decimal ASCII, no newline
        if (sp < 1) return done(2);
        const s = String(D[sp - 1]);
        if (ol + s.length > 65536) return done(11);
        sp--;
        for (let i = 0; i < s.length; i++) out[ol++] = s.charCodeAt(i);
        break;
      }
      case 0x51: // PUTC: one byte, v AND 255
        if (sp < 1) return done(2);
        if (ol + 1 > 65536) return done(11);
        out[ol++] = D[--sp] & 255;
        break;
      case 0x52: // IN: next input byte, -1 once used up
        if (sp === 256) return done(3);
        D[sp++] = ip < inp.length ? inp[ip++] : -1;
        break;
      case 0x53: // EXIT: code is v AND 255
        if (sp < 1) return done(2);
        return done(D[--sp] & 255);
    }
  }
}

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
for (const id of readdirSync(I).sort()) {
  const [stdout, code] = run(
    new Uint8Array(readFileSync(join(I, id, 'program.bin'))),
    new Uint8Array(readFileSync(join(I, id, 'input.bin'))),
  );
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'stdout.bin'), stdout);
  writeFileSync(join(O, id, 'exit.txt'), `${code}\n`);
}
