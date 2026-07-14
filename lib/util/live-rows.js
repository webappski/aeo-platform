// Multi-row live status manager for parallel task dispatch.
//
// Problem it solves: `run` fires N parallel cells through the scheduler.
// Each one's status (queued / running / cooldown / done / error) needs to
// be visible in real time, on its own line, with an active spinner — not
// a static "Running…" jam-line that looks frozen for 60s during pacing.
//
// Design constraints (mirror lib/util/spinner.js):
//   - TTY-only animation. Non-TTY (CI, pipe, legacy Windows console) gets
//     a structured "start / finish" log per task with no ANSI codes — better
//     than the previous horizontal jumble but no flicker for CI parsers.
//   - NO_COLOR respected. Falls back to ASCII spinner frames.
//   - Zero dependencies. Pure stream writes.
//   - Cursor restored on Ctrl+C / process exit. Standard SIGINT pattern.
//
// ANSI codes used:
//   \x1b[NA   move cursor up N lines
//   \x1b[2K   clear entire current line
//   \x1b[?25l hide cursor
//   \x1b[?25h show cursor (always restored)

const FRAMES_UNICODE = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const FRAMES_ASCII   = ['.  ', '.. ', '...', ' ..', '  .', '   '];
const INTERVAL_MS = 100;
// Ceiling for the adaptive label column (see labelColWidth). Labels wider than
// this are sliced so a pathologically long one can't swallow the whole line and
// starve `detail`. This is a CAP, not a fixed width — the column normally sizes
// itself to the widest label actually present. The old fixed 28-wide column was
// tuned for `run`'s short parallel-cell labels and chopped `report`'s long
// descriptive ones ("Classifying competitor pricing tiers…" → "…competitor prici").
const LABEL_WIDTH_CAP = 60;

const DIM   = '\x1b[2m';
const RESET = '\x1b[0m';
const RED   = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';

/**
 * @typedef {'queued'|'running'|'cooldown'|'ledger-wait'|'done'|'error'} RowStatus
 * @typedef {Object} Row
 * @property {string} label
 * @property {RowStatus} status
 * @property {string} detail
 * @property {string=} labelPrefix  1.0.7: template prefix for live countdown ("TPM rate-limit — ")
 * @property {number=} deadlineMs   1.0.7: absolute timestamp when cooldown/ledger-wait ends
 * @property {number} startedAt
 * @property {number=} endedAt
 */

/**
 * @typedef {Object} LiveRows
 * @property {(id: string, label: string) => void} add
 * @property {(id: string, patch: {status?: RowStatus, detail?: string, labelPrefix?: string, deadlineMs?: number}) => void} update
 * @property {(id: string, patch: {status: RowStatus, detail?: string}) => void} finish
 * @property {(line: string) => void} log
 * @property {(header?: string) => void} start  1.0.7: optional header line (e.g. "press Ctrl+C to abort")
 * @property {() => void} stop
 */

/**
 * @param {Object} [opts]
 * @param {NodeJS.WritableStream} [opts.stream]   default: process.stderr (stdout reserved for --json)
 * @param {boolean} [opts.isTTY]                  override for tests; default: stream.isTTY
 * @param {boolean} [opts.useColor]               default: isTTY && !NO_COLOR
 * @param {boolean} [opts.useUnicode]             default: useColor && !legacy Windows console
 * @param {boolean} [opts.animate]                override; default: isTTY && !legacy Windows console
 * @returns {LiveRows}
 */
export function createLiveRows(opts = {}) {
  const stream = opts.stream || process.stderr;
  const isTTY = opts.isTTY !== undefined ? opts.isTTY : !!stream.isTTY;
  const useColor = opts.useColor !== undefined ? opts.useColor : (isTTY && !process.env.NO_COLOR);
  // Match spinner.js's legacy Windows console detection — old conhost without
  // UTF-8 codepage renders braille frames as boxes, and ANSI cursor codes are
  // broken there too.
  const isLegacyWinConsole = process.platform === 'win32'
    && !process.env.WT_SESSION
    && !process.env.TERM_PROGRAM;
  const useUnicode = opts.useUnicode !== undefined
    ? opts.useUnicode
    : (useColor && !isLegacyWinConsole);
  // Animation requires both TTY and a non-legacy console (ANSI cursor codes work).
  // Allow tests to force animate=true even on legacy detection.
  const animate = opts.animate !== undefined ? opts.animate : (isTTY && !isLegacyWinConsole);
  const frames = useUnicode ? FRAMES_UNICODE : FRAMES_ASCII;

  /** @type {Map<string, Row>} */
  const rows = new Map();
  /** @type {string[]} */
  const logBuffer = [];
  let frameIdx = 0;
  let timer = null;
  let signalsRegistered = false;
  let sigintHandler = null;
  let exitHandler = null;

  function colorize(text, color) {
    if (!useColor) return text;
    return `${color}${text}${RESET}`;
  }

  function iconFor(status) {
    switch (status) {
      case 'done':        return colorize('✓', GREEN);
      case 'error':       return colorize('✗', RED);
      case 'cooldown':
      case 'ledger-wait': return colorize('⏱', YELLOW);
      case 'queued':      return colorize('⋯', DIM);
      case 'running':
      default:            return colorize(frames[frameIdx % frames.length], DIM);
    }
  }

  // 1.0.7: recompute live countdown for waiting rows. Called by renderAll
  // each tick so the displayed seconds tick down (60s → 59s → 58s …) instead
  // of looking frozen. Computed from absolute deadlineMs, not decremented —
  // drift-immune if the render loop falls behind.
  function rerender(row) {
    const isWaiting = row.status === 'cooldown' || row.status === 'ledger-wait';
    if (isWaiting && row.deadlineMs != null && row.labelPrefix != null) {
      const remainingMs = Math.max(0, row.deadlineMs - Date.now());
      const sec = Math.ceil(remainingMs / 1000);
      row.displayDetail = sec > 0
        ? `${row.labelPrefix}${sec}s remaining`
        : `${row.labelPrefix}releasing…`;
    } else {
      row.displayDetail = row.detail;
    }
  }

  // Adaptive label-column width: pad every label to the widest label CURRENTLY
  // in the block so the icon/detail columns still line up, capped at
  // LABEL_WIDTH_CAP so one long label can't starve `detail`. Recomputed per
  // render — renderAll() redraws every row each frame, so a newly-added longer
  // label re-aligns the whole block on the next tick. This is what lets `report`
  // show full descriptive labels while `run` keeps its neat short column.
  function labelColWidth() {
    let max = 0;
    for (const row of rows.values()) {
      if (row.label.length > max) max = row.label.length;
    }
    return Math.min(max, LABEL_WIDTH_CAP);
  }

  function formatRow(row) {
    const icon = iconFor(row.status);
    const width = labelColWidth();
    const labelPart = row.label.length > width
      ? row.label.slice(0, width)
      : row.label.padEnd(width);
    const labelColored = (row.status === 'done' || row.status === 'error')
      ? labelPart
      : colorize(labelPart, DIM);
    // 1.0.7: prefer displayDetail when rerender computed a live countdown;
    // fall back to raw detail otherwise.
    const detailPart = row.displayDetail || row.detail || '';
    return `  ${icon} ${labelColored} ${detailPart}`;
  }

  // Terminal width for wrap-safe rendering. Each row MUST occupy exactly one
  // physical line or renderAll's `\x1b[${rows.size}A` cursor-up count desyncs
  // and the whole block scrambles. A long detail string (e.g. a full result
  // sentence) would wrap on a narrow TTY, so we clamp every rendered row to
  // (columns - 1) visible cols. Re-read per frame: the user can resize mid-run.
  // 0 = unknown width (non-TTY test stream) → truncateToWidth leaves it alone.
  function maxCols() {
    return stream.columns ? stream.columns - 1 : 0;
  }

  function renderAll() {
    if (!animate) return;
    if (rows.size === 0) return;
    // Move cursor up to the first row, then redraw each one. After loop,
    // cursor sits just past the last row — same position the next frame
    // assumes.
    const cols = maxCols();
    stream.write(`\x1b[${rows.size}A`);
    for (const row of rows.values()) {
      rerender(row);   // 1.0.7: compute live countdown for waiting rows
      stream.write('\x1b[2K\r' + truncateToWidth(formatRow(row), cols) + '\n');
    }
    frameIdx = (frameIdx + 1) % frames.length;
  }

  function registerSignalHandlers() {
    if (signalsRegistered) return;
    signalsRegistered = true;
    sigintHandler = () => {
      // 1.0.7: flush any buffered token-cost logs before exiting so
      // AEO_LOG_TOKENS=1 output isn't lost on Ctrl+C.
      if (logBuffer.length > 0) {
        for (const line of logBuffer) {
          stream.write(line.endsWith('\n') ? line : line + '\n');
        }
        logBuffer.length = 0;
      }
      restoreCursor();
      // 130 = standard exit code for SIGINT (128 + signal number 2).
      process.exit(130);
    };
    exitHandler = () => {
      restoreCursor();
    };
    process.once('SIGINT', sigintHandler);
    process.once('exit', exitHandler);
  }

  function unregisterSignalHandlers() {
    if (!signalsRegistered) return;
    if (sigintHandler) process.off('SIGINT', sigintHandler);
    if (exitHandler) process.off('exit', exitHandler);
    sigintHandler = null;
    exitHandler = null;
    signalsRegistered = false;
  }

  function restoreCursor() {
    if (animate) stream.write(SHOW_CURSOR);
  }

  function add(id, label) {
    if (rows.has(id)) return;  // idempotent — caller may re-add
    rows.set(id, {
      label,
      status: 'queued',
      detail: 'queued',
      startedAt: Date.now(),
    });
    // Reserve a terminal row immediately. On TTY: write a placeholder so the
    // next renderAll() correctly accounts for this row in its cursor math.
    // On non-TTY: print the start line once (CI logs see one structured event).
    if (animate) {
      // Same wrap-safety as renderAll: a long placeholder must not wrap before
      // the first frame, or the initial cursor-up count is already off by one.
      stream.write(truncateToWidth(formatRow(rows.get(id)), maxCols()) + '\n');
    } else {
      stream.write(stripColor(formatRow(rows.get(id))) + '\n');
    }
  }

  function update(id, patch) {
    const row = rows.get(id);
    if (!row) return;
    if (patch.status) row.status = patch.status;
    if (patch.detail !== undefined) row.detail = patch.detail;
    // 1.0.7: forward the live-countdown fields. Use `in` operator so explicit
    // `null` from the caller clears the prior value (e.g. on transition to
    // a different waiting state with a fresh deadline).
    if ('labelPrefix' in patch) row.labelPrefix = patch.labelPrefix;
    if ('deadlineMs' in patch) row.deadlineMs = patch.deadlineMs;
    // Clear stale countdown when status moves out of waiting states — a row
    // going cooldown → running must not keep ticking down to 0.
    if (patch.status === 'running' || patch.status === 'done' || patch.status === 'error') {
      row.deadlineMs = null;
      row.labelPrefix = null;
    }
    // TTY: next renderAll() picks up changes. Non-TTY: stay silent until finish().
  }

  function finish(id, patch) {
    const row = rows.get(id);
    if (!row) return;
    if (patch.status) row.status = patch.status;
    if (patch.detail !== undefined) row.detail = patch.detail;
    row.endedAt = Date.now();
    if (!animate) {
      stream.write(stripColor(formatRow(row)) + '\n');
    }
    // TTY: stays in render loop until stop(); the row freezes visually
    // because iconFor() returns ✓/✗ for done/error (no spinner animation).
  }

  function log(line) {
    // Coerce at the boundary: logBuffer is contractually string[] and every
    // flush site (stop(), the SIGINT handler) calls .endsWith() on each entry,
    // so a stray non-string caller would crash the flush — potentially after
    // real work has completed. String() is a no-op for the normal string path.
    const s = typeof line === 'string' ? line : String(line);
    if (animate) {
      logBuffer.push(s);  // flush in stop()
    } else {
      stream.write(s.endsWith('\n') ? s : s + '\n');
    }
  }

  function start(header) {
    if (!animate) return;
    if (timer) return;
    registerSignalHandlers();
    stream.write(HIDE_CURSOR);
    // 1.0.7: optional header line above the live region. Tells operators
    // the process is interruptible. Caller passes a short hint like
    // "press Ctrl+C to abort cleanly". Header lives above the row block
    // and is not redrawn — renderAll's cursor math only covers rows.
    if (header) {
      stream.write(colorize(header, DIM) + '\n');
    }
    // Don't write rows on start — add() already wrote placeholders. Just kick
    // off the refresh loop; first frame fires on next tick.
    timer = setInterval(renderAll, INTERVAL_MS);
  }

  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    if (animate) {
      // One final paint so completed rows reflect their last state.
      renderAll();
      restoreCursor();
    }
    // Flush any buffered logs after the row block.
    if (logBuffer.length > 0) {
      for (const line of logBuffer) {
        stream.write(line.endsWith('\n') ? line : line + '\n');
      }
      logBuffer.length = 0;
    }
    unregisterSignalHandlers();
  }

  return { add, update, finish, log, start, stop };
}

// Strip ANSI escape codes from a string. Used in non-TTY mode where we still
// want the row's content but without color/control chars.
function stripColor(s) {
  return s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
}

// Sticky (anchored) ANSI SGR/escape matcher for truncateToWidth's scan.
const ANSI_SEQ = /\x1b\[[0-9;?]*[A-Za-z]/y;

/**
 * Clamp a formatted (possibly ANSI-colored) row to at most `maxVisible`
 * VISIBLE columns so it can never wrap to a second physical line — wrapping
 * breaks renderAll's one-line-per-row `\x1b[NA` cursor math and scrambles the
 * whole live block. Escape sequences don't count toward width and are copied
 * through verbatim; if we cut the row short we append a reset so a still-open
 * color can't bleed onto the next line. maxVisible <= 0 means "unknown width"
 * (e.g. a non-TTY test stream) and returns the string untouched.
 *
 * Note: width is counted in code units, matching formatRow's own padEnd/length
 * assumptions — good enough for this codebase's latin + a few symbol glyphs; it
 * does not attempt full Unicode east-asian-width measurement.
 *
 * @param {string} s
 * @param {number} maxVisible
 * @returns {string}
 */
function truncateToWidth(s, maxVisible) {
  if (!(maxVisible > 0)) return s;
  let out = '';
  let visible = 0;
  let i = 0;
  const n = s.length;
  while (i < n) {
    if (s[i] === '\x1b') {
      ANSI_SEQ.lastIndex = i;
      const m = ANSI_SEQ.exec(s);
      if (m) { out += m[0]; i = ANSI_SEQ.lastIndex; continue; }
    }
    if (visible >= maxVisible) return out + RESET;
    out += s[i];
    visible++;
    i++;
  }
  return out;
}
