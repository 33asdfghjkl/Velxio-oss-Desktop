/**
 * Per-simulator bridge state for custom chips.
 *
 * Each simulator family exposes its peripherals differently:
 *   - AVR (avr8js)   — `simulator.usart` / `simulator.i2cBus`
 *   - RP2040 (rp2040js) — `simulator.serialWriteByte` / `simulator.getBusBinding`
 *   - ESP32 (bridge shim) — `simulator.sendPinEvent`. The shim wraps either
 *     the backend QEMU bridge, which hosts custom chips in its worker
 *     (CustomChipPart hands the WASM over and no browser instance exists),
 *     or an overlay's in-browser engine, which answers `hostsCustomChips()`
 *     false so the chip runs here, GPIO through the shim's PinManager.
 *
 * What is left here is the family fingerprint and the worker question. No
 * bus dispatcher lives here any more: a chip joins a bus from vx_spi_attach,
 * vx_i2c_attach and vx_uart_attach, and the fabric (simulation/buses) routes
 * it by its wiring.
 */
export type SimulatorKind = 'avr' | 'rp2040' | 'esp32' | 'unknown';

/**
 * Which family a simulator belongs to, from the shape of its surface. These
 * are FINGERPRINTS of the family, never a place to hang a chip: a chip's SPI,
 * I2C and UART bytes all come from the bus fabric.
 *
 * They used to read `spi` and `setSPIHandler` (the F2 transition bridge,
 * gone with F3), then `addI2CDevice` (the I2C one, gone with F5), and the
 * UART bridge went with F6. The RP family answers to `serialWriteByte` (the
 * monitor's byte seam, which the AVR lacks and the ESP32 shim lacks too)
 * plus `getBusBinding`, the fabric's way in.
 */
export function detectSimulatorKind(simulator: any): SimulatorKind {
  if (!simulator) return 'unknown';
  if (simulator.usart && simulator.i2cBus) return 'avr';
  if (
    typeof simulator.serialWriteByte === 'function' &&
    typeof simulator.getBusBinding === 'function'
  ) {
    return 'rp2040';
  }
  if (typeof simulator.sendPinEvent === 'function') return 'esp32';
  return 'unknown';
}

/**
 * Whether an ESP32-kind simulator hosts custom chips in a backend worker
 * (the QEMU path: the WASM is shipped with `registerSensor` and runs next
 * to the guest) or leaves them to the browser runtime. The shim answers
 * for whichever bridge the build installed; a bridge with no opinion is the
 * OSS QEMU one, and QEMU hosts them. An in-browser engine has no worker,
 * so it must say no, or the chip is filed as a sensor nothing runs.
 */
export function hostsChipsInWorker(simulator: any): boolean {
  if (!simulator) return false;
  if (typeof simulator.hostsCustomChips !== 'function') return true;
  try {
    return simulator.hostsCustomChips() !== false;
  } catch {
    return true;
  }
}

// ── UART ────────────────────────────────────────────────────────────────────
//
// There is no UART bridge any more either. A chip is on a board's UART wires
// from vx_uart_attach, by the pads of its own config (CustomChipPart puts it
// on the bus fabric of simulation/buses), and the fabric decides from the
// nets which controller of which board each pad reaches, or follows a plain
// GPIO on the guest's clock. What stood here installed ONE dispatcher per
// SIMULATOR on its USART0 (rebuilt by every reset and reload, so the chip
// went deaf: findings avr-uart-dispatcher-lost-after-recompile-or-stop and
// avr-uart-dispatcher-lost-on-reload), made a chip on RP2040-family hosts
// hear every UART through the console callback and answer on UART0 only
// (rp2040-uart-lumped-and-uart0-only-rx), and drained the chip's replies into
// the AVR through a wall-clock timer FIFO shared per simulator that outlived
// Stop (avr-rx-queue-stale-and-throttled).

// ── SPI ─────────────────────────────────────────────────────────────────────
//
// There is no SPI bridge any more. A chip joins a board's SPI bus from
// vx_spi_attach, with the pins of its own config (ChipRuntime._joinSpiBus),
// and the fabric in simulation/buses decides which bus that is and when the
// chip is selected. What stood here installed one dispatcher per SIMULATOR,
// whatever the chip was wired to and whatever bus it spoke: on AVR and the
// ESP32 shim it joined the part chain, and on RP2040, RP2350 and the XIAO it
// replaced the SPI handler on both buses. A UART-only Grove module took the
// board's SPI with it (issue #355 and findings
// grove-chip-takes-spi-on-rp-and-xiao-arm, customchip-setspihandler-steals-bus0,
// rp2-sethandler-clobbers-spi-chain).
