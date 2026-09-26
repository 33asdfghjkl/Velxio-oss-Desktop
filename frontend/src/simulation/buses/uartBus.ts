/**
 * One UART net = one board pin and the wire on it (DESIGN sections 3.3 and
 * 6.2). A UART line has no bus arbitration: it has DRIVERS (whoever
 * transmits onto the wire) and LISTENERS (whoever receives from it), and a
 * byte any driver puts on the wire reaches every listener. On a board pin
 * the possible drivers are a controller whose TX is routed there and the
 * endpoints whose TX leg lands there; the listeners are a controller whose
 * RX is routed there and the endpoints whose RX leg lands there. One TX to
 * several RX is legal and works; two TX on one wire is the contention silicon
 * suffers, and is reported.
 *
 * Rates: an endpoint declares the baud it talks at, a controller reports the
 * one the guest configured. When they disagree beyond what a receiver
 * tolerates, the listener gets what silicon would read at its own rate from
 * the sender's frame (see resampleUartFrame), and the mismatch is reported
 * once. A listener that declares no rate takes bytes as they are.
 */

import type { DiagnosticSink } from './spiBus';
import type { UartConfig, UartEndpoint, UartEndpointDescriptor } from './types';
import {
  baudsMatch,
  DEFAULT_UART_FRAME,
  frameName,
  parseUartFrame,
  resampleUartFrame,
  sameFrame,
  validBaud,
  type UartFrameErrors,
  type UartFrameSpec,
} from './uartFrame';

/** Net-side view of one leg of a registered endpoint. */
export interface UartMember {
  readonly owner: string;
  readonly desc: UartEndpointDescriptor;
  readonly endpoint: UartEndpoint;
  /** Which leg of the endpoint this is: its RX listens here, its TX drives here. */
  readonly role: 'rx' | 'tx';
  /** The endpoint's frame, parsed once. */
  readonly spec: UartFrameSpec;
  /** The endpoint's rate, when it declares a usable one. */
  readonly baud: number | undefined;
}

/** What the net needs of a controller routed to its pin. */
export interface UartControllerRef {
  readonly unit: number;
  readonly name: string;
  readonly remote: boolean;
  config(): UartConfig;
  /** A byte into the controller's RX (only used through `controllerRx`). */
  receive(byte: number): void;
}

/** A listener's rate and frame, the key its software decoder is shared under. */
export function listenerKey(m: UartMember): string {
  return `${m.baud}|${frameName(m.spec)}`;
}

export function uartMember(
  desc: UartEndpointDescriptor,
  endpoint: UartEndpoint,
  role: 'rx' | 'tx',
): UartMember {
  return {
    owner: desc.owner,
    desc,
    endpoint,
    role,
    spec: parseUartFrame(desc.frame),
    baud: validBaud(desc.baud) ? desc.baud : undefined,
  };
}

export class UartNet {
  /** Endpoints whose RX leg is on this pin, by owner. */
  readonly listeners = new Map<string, UartMember>();
  /** Endpoints whose TX leg is on this pin, by owner. */
  readonly drivers = new Map<string, UartMember>();
  /** The controller whose TX is routed to this pin, if any (set by the fabric). */
  controllerTx: UartControllerRef | null = null;
  /** The controller whose RX is routed to this pin, if any (set by the fabric). */
  controllerRx: UartControllerRef | null = null;
  /**
   * Installed by the fabric when the pin is a plain GPIO the MCU reads: puts
   * a byte an endpoint transmits on the wire as timed edges, so a
   * SoftwareSerial RX sees it. Null when a controller's RX takes the byte
   * directly, or when the board cannot time edges.
   */
  emit: ((byte: number, baud: number, spec: UartFrameSpec) => void) | null = null;

  readonly boardId: string;
  readonly pin: number;
  private readonly report: DiagnosticSink;

  constructor(boardId: string, pin: number, report: DiagnosticSink) {
    this.boardId = boardId;
    this.pin = pin;
    this.report = report;
  }

  get size(): number {
    return this.listeners.size + this.drivers.size;
  }

  add(m: UartMember): void {
    (m.role === 'rx' ? this.listeners : this.drivers).set(m.owner, m);
  }

  remove(owner: string, role: 'rx' | 'tx'): void {
    (role === 'rx' ? this.listeners : this.drivers).delete(owner);
  }

  /** Listeners in owner order, so nothing depends on attach order. */
  private sortedListeners(): UartMember[] {
    return Array.from(this.listeners.values()).sort((a, b) => (a.owner < b.owner ? -1 : a.owner > b.owner ? 1 : 0));
  }

  // ── Bytes ────────────────────────────────────────────────────────────────

  /** A byte the controller routed to this pin transmits. */
  fromController(ctl: UartControllerRef, byte: number): void {
    const cfg = ctl.config();
    const baud = validBaud(cfg.baud) ? cfg.baud : undefined;
    const spec = cfg.frame ? parseUartFrame(cfg.frame) : undefined;
    for (const m of this.sortedListeners()) this.deliver(m, byte, baud, spec, ctl.name);
    // A board's TX wired to one of its own RX pins: a loopback, as on the bench.
    if (this.controllerRx) this.toController(this.controllerRx, byte, baud, spec, ctl.name);
  }

  /** A byte an endpoint whose TX leg is here transmits. */
  fromEndpoint(m: UartMember, byte: number): void {
    for (const l of this.sortedListeners()) this.deliver(l, byte, m.baud, m.spec, m.owner);
    if (this.controllerRx) {
      this.toController(this.controllerRx, byte, m.baud, m.spec, m.owner);
      return;
    }
    if (!this.emit) return;
    // The wire is a GPIO the guest samples itself: the byte goes out as edges.
    if (m.baud === undefined) return; // reported at placement (uart-no-baud)
    this.emit(byte & 0xff, m.baud, m.spec);
  }

  /**
   * A byte the software decoder read off the wire (the MCU bit-banged it)
   * for the listeners decoding at `key`. The decoder ran at their own rate,
   * so a wrong rate has already produced its garbage; a parity error is
   * dropped as a hardware receiver drops it.
   */
  fromWire(key: string, byte: number, errors: UartFrameErrors): void {
    if (errors.parity) return;
    for (const m of this.sortedListeners()) if (listenerKey(m) === key) m.endpoint.receive(byte & 0xff);
  }

  private deliver(
    m: UartMember,
    byte: number,
    srcBaud: number | undefined,
    srcSpec: UartFrameSpec | undefined,
    srcName: string,
  ): void {
    const b = byte & 0xff;
    if (srcBaud === undefined || m.baud === undefined) {
      m.endpoint.receive(b);
      return;
    }
    const spec = srcSpec ?? m.spec;
    if (baudsMatch(srcBaud, m.baud) && sameFrame(spec, m.spec)) {
      m.endpoint.receive(b);
      return;
    }
    this.mismatch([m.owner], m.owner, m.baud, m.spec, srcName, srcBaud, spec);
    for (const out of resampleUartFrame(b, spec, srcBaud, m.spec, m.baud)) m.endpoint.receive(out);
  }

  private toController(
    ctl: UartControllerRef,
    byte: number,
    srcBaud: number | undefined,
    srcSpec: UartFrameSpec | undefined,
    srcName: string,
  ): void {
    const b = byte & 0xff;
    const cfg = ctl.config();
    const baud = validBaud(cfg.baud) ? cfg.baud : undefined;
    if (srcBaud === undefined || baud === undefined) {
      ctl.receive(b);
      return;
    }
    // A side that does not say its frame is taken to use the other side's.
    const spec = cfg.frame ? parseUartFrame(cfg.frame) : (srcSpec ?? DEFAULT_UART_FRAME);
    const from = srcSpec ?? spec;
    if (baudsMatch(srcBaud, baud) && sameFrame(spec, from)) {
      ctl.receive(b);
      return;
    }
    this.mismatch([srcName], ctl.name, baud, spec, srcName, srcBaud, from);
    for (const out of resampleUartFrame(b, from, srcBaud, spec, baud)) ctl.receive(out);
  }

  // ── Diagnostics ──────────────────────────────────────────────────────────

  private mismatch(
    owners: string[],
    receiver: string,
    rxBaud: number,
    rxSpec: UartFrameSpec,
    sender: string,
    txBaud: number,
    txSpec: UartFrameSpec,
  ): void {
    const rate = (baud: number, spec: UartFrameSpec) => `${Math.round(baud)} baud ${frameName(spec)}`;
    this.report({
      code: 'uart-baud-mismatch',
      bus: 'uart',
      boardId: this.boardId,
      owners: owners.slice().sort(),
      message:
        `${receiver} listens at ${rate(rxBaud, rxSpec)} on pin ${this.pin}, but ${sender} sends at ` +
        `${rate(txBaud, txSpec)}: what it receives is garbage, as on hardware. Use the same rate ` +
        `and frame on both sides.`,
    });
  }

  /**
   * Two drivers on one wire. Checked when membership or routing changes,
   * never per byte: the wiring is wrong before anything is sent.
   */
  checkDrivers(): void {
    const owners = Array.from(this.drivers.keys()).sort();
    const names = [...owners];
    if (this.controllerTx) names.push(this.controllerTx.name);
    if (names.length < 2) return;
    const crossed = this.controllerTx !== null;
    this.report({
      code: 'uart-tx-contention',
      bus: 'uart',
      boardId: this.boardId,
      owners,
      message:
        `${names.join(' and ')} all transmit on pin ${this.pin}: two TX on one wire fight each other ` +
        (crossed
          ? `and the board cannot hear the module. Wire the module's TX to the board's RX pin.`
          : `and the board reads a mix of both. Give each module its own RX pin.`),
    });
  }

  /**
   * An endpoint listening on the pin the controller listens on: nobody
   * drives that wire, so the module hears nothing. RX to RX is the crossed
   * half of the classic UART wiring mistake (TX to TX is the contention).
   */
  checkListeners(): void {
    const ctl = this.controllerRx;
    if (!ctl || this.controllerTx) return;
    for (const m of this.sortedListeners()) {
      this.report({
        code: 'uart-wiring',
        bus: 'uart',
        boardId: this.boardId,
        owners: [m.owner],
        message:
          `${m.owner}: its RX is on pin ${this.pin}, which ${ctl.name} uses as its own RX, so nothing ` +
          `on that wire ever transmits and the module hears nothing. Wire the module's RX to the ` +
          `board's TX pin.`,
      });
    }
  }
}
