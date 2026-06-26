/**
 * Presentation Markdown report generator.
 *
 * Produces a human-readable `report_presentation.md` from a `ReportContext`.
 * New in this refactor:
 *   - Chaos tables include a jitter-contamination column.
 *   - A footnote explains the memory noise-floor methodology.
 */

import type { ReportContext, FcSummaryEntry } from './types';
import type { ChaosRunResult } from '../chaos/types';
import type { CodecBenchmarkResult } from '../codec/types';

function fmt(n: number | undefined, digits = 0): string {
  if (n === undefined || Number.isNaN(n)) {
    return '-';
  }
  return n.toLocaleString('en-US', { maximumFractionDigits: digits });
}

function fmtLatencyUs(ms: number | undefined): string {
  if (ms === undefined || Number.isNaN(ms)) {
    return '-';
  }
  return fmt(ms * 1000, 1);
}

function fmtRate(ops: number | undefined): string {
  if (ops === undefined || Number.isNaN(ops)) {
    return '-';
  }
  if (ops >= 1_000_000) {
    return `${(ops / 1_000_000).toFixed(2)} M`;
  }
  if (ops >= 1000) {
    return `${(ops / 1000).toFixed(2)} k`;
  }
  return fmt(ops, 0);
}

function cpuPerOp(result: CodecBenchmarkResult | ChaosRunResult): string {
  const us = 'cpu' in result && result.cpu ? result.cpu.usPerOp : undefined;
  return us !== undefined ? fmt(us, 2) : '-';
}

function renderHeader(context: ReportContext): string {
  return [
    '# Benchmark Report',
    '',
    `- Generated: ${context.date}`,
    `- Duration: ${context.durationSec}s`,
    `- Runs per test: ${context.numRuns}`,
    '',
  ].join('\n');
}

function renderEnvironment(context: ReportContext): string {
  return [
    '## Environment',
    '',
    '| Signal | Value |',
    '|--------|-------|',
    `| Platform | ${context.sys.platform} |`,
    `| CPU | ${context.sys.cpu} |`,
    `| Cores | ${context.sys.cores} |`,
    `| Memory | ${context.sys.memory} |`,
    `| Node.js | ${context.sys.nodeVersion} |`,
    `| V8 | ${context.sys.v8Version} |`,
    '',
  ].join('\n');
}

function renderVersions(context: ReportContext): string {
  const lines = ['## Competitors', '', '| Library | Version |', '|---------|---------|'];
  lines.push(`| njs-modbus | ${context.versions.own} |`);
  if (context.versions.jsmodbus) {
    lines.push(`| jsmodbus | ${context.versions.jsmodbus} |`);
  }
  if (context.versions.modbusSerial) {
    lines.push(`| modbus-serial | ${context.versions.modbusSerial} |`);
  }
  lines.push('');
  return lines.join('\n');
}

function renderMethodology(): string {
  return [
    '## Methodology',
    '',
    '- Latency percentiles are computed from a reservoir sample of per-operation timings.',
    '- Multi-run results use the median run to reduce environment jitter.',
    '- Jitter-contaminated measurements are flagged when the event-loop stall detector fires.',
    '- Memory deltas are reported after forced GC; the noise-floor baseline is subtracted to produce `netHeapGrowthKB`.',
    '- Chaos overall correct rate uses recoverable frames as the denominator: `sum(framesCorrect) / sum(expectedCorrect)` across scenes with `expectedCorrect > 0`. Fully-unrecoverable scenes (e.g. `corrupt`, `truncated`) are excluded from the rate so a perfect parser shows 100%.',
    "- `njs-modbus` uses `queueStrategy: 'fifo'` in sequential modes to match the FIFO request ordering of `jsmodbus` and `modbus-serial`; multi-connection TCP tests use `queueStrategy: 'concurrent'` for true pipelining.",
    '',
  ].join('\n');
}

function renderEncodeDecode(context: ReportContext): string {
  if (!context.encodeDecode) {
    return '';
  }
  const lines = [
    '## Encode / Decode Micro-benchmark',
    '',
    'Pure CPU micro-benchmark of njs-modbus encode/decode hot paths — no network I/O. Each op completes in sub-microsecond time, so `Ops/sec` and `CPU (µs/op)` are the reliable indicators; per-op latency at this scale is dominated by `process.hrtime` overhead and is omitted.',
    '',
    '| Suite | Ops/sec | CPU (µs/op) |',
    '|-------|---------|-------------|',
  ];
  for (const { suite, metrics } of context.encodeDecode.suites) {
    for (const result of Object.values(metrics)) {
      lines.push(`| ${suite} | ${fmtRate(result.opsPerSecond)} | ${cpuPerOp(result)} |`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

function renderChaos(context: ReportContext): string {
  if (!context.chaos) {
    return '';
  }
  const lines = [
    '## Chaos Scenes',
    '',
    'End-to-end resilience benchmark: sends corrupted, fragmented, and sticky frames to real Modbus servers and measures frame-level correctness, recovery latency after noise stops, and any heap retained across the run.',
    '',
    '- **Sent (plan/actual)**: planned request count vs requests actually completed. When the circuit breaker trips (5 consecutive timeouts), remaining requests are marked failed instantly and the actual count drops below plan. Shown as a single value when plan equals actual.',
    '- **Correct / Failed / Extra**: absolute frame counts. **Failed** = sent frames that did not receive a correct response. **Extra** = received frames that do not match any sent request.',
    '- **✅ / ❌**: scene pass/fail mark before the library name. RTU and ASCII pass when the library recovers every recoverable frame from the byte stream (`framesCorrect == expectedCorrect`). TCP also passes under a stricter per-packet rule: parse from the start of each `socket.write` packet until the first error, count only frames whose header lands at a packet boundary or immediately follows another counted frame (`framesCorrect == expectedStrictCorrect`).',
    '- **Recovery P99**: P99 latency (µs) of 100 clean frames sent after chaos noise stops; measures how quickly a parser re-syncs. A trailing ⚠ means the event-loop stall detector fired during the run and latency may be inflated.',
    '- **Max CPU (µs)**: worst-case single-iteration CPU time. <1000 µs (1 ms) is flat-line stable; higher values indicate occasional CPU stalls that could jitter application-layer timing.',
    '- **Net heap (KB)**: heapUsed delta after forced GC + settle, with a calibrated noise floor subtracted. Lower is better; a positive value means the library retained memory across the window.',
    '',
  ];

  const header = '| Scene | Library | Sent | Correct | Failed | Extra | Recovery P99 (µs) | Max CPU (µs) | Net heap (KB) |';
  const sep = '|-------|---------|------|---------|--------|-------|-------------------|--------------|---------------|';

  // Group scenes by protocol for the per-protocol sub-tables.
  const byProtocol = new Map<string, typeof context.chaos.scenes>();
  for (const scene of context.chaos.scenes) {
    const list = byProtocol.get(scene.protocol);
    if (list) {
      list.push(scene);
    } else {
      byProtocol.set(scene.protocol, [scene]);
    }
  }

  for (const protocol of ['TCP', 'RTU', 'ASCII']) {
    const scenes = byProtocol.get(protocol);
    if (!scenes || scenes.length === 0) {
      continue;
    }

    // Aggregate per-library scene-pass count and frame totals for the summary block.
    // `recoverableExpected` excludes scenes where every frame is unrecoverable (e.g.
    // `corrupt`, `truncated`) so the rate denominator only counts recoverable frames —
    // matching the legacy report's "overall correct rate" semantics.
    const libStats = new Map<string, { passed: number; recoverableCorrect: number; recoverableExpected: number; total: number }>();
    for (const scene of scenes) {
      for (const [library, result] of Object.entries(scene.metrics)) {
        const s = libStats.get(library) ?? { passed: 0, recoverableCorrect: 0, recoverableExpected: 0, total: 0 };
        if (result.accuracyPass) {
          s.passed++;
        }
        if (result.expectedCorrect > 0) {
          s.recoverableCorrect += result.framesCorrect;
          s.recoverableExpected += result.expectedCorrect;
        }
        s.total++;
        libStats.set(library, s);
      }
    }
    // njs-modbus first, then alphabetical.
    const orderedLibs = [...libStats.keys()].sort((a, b) => {
      if (a === 'njs-modbus') {
        return -1;
      }
      if (b === 'njs-modbus') {
        return 1;
      }
      return a.localeCompare(b);
    });

    lines.push(`### ${protocol}`);
    lines.push('');
    for (const library of orderedLibs) {
      const s = libStats.get(library);
      if (!s) {
        continue;
      }
      const allPassed = s.passed === s.total;
      const correctRate = s.recoverableExpected > 0 ? (s.recoverableCorrect / s.recoverableExpected) * 100 : 0;
      const mark = allPassed ? '✅ ' : '';
      const libDisplay = library === 'njs-modbus' ? `**${library}**` : library;
      lines.push(`- ${mark}${libDisplay}: passed ${s.passed}/${s.total} scenes, overall correct rate ${correctRate.toFixed(1)}%`);
    }
    lines.push('');
    lines.push(header);
    lines.push(sep);
    for (const scene of scenes) {
      // Stable order: njs-modbus first (baseline), then alphabetical.
      const entries = Object.entries(scene.metrics).sort(([a], [b]) => {
        if (a === 'njs-modbus') {
          return -1;
        }
        if (b === 'njs-modbus') {
          return 1;
        }
        return a.localeCompare(b);
      });
      entries.forEach(([library, result], idx) => {
        const isBaseline = library === 'njs-modbus';
        const sceneCell = idx === 0 ? `**${scene.shortLabel}**` : '';
        const mark = result.accuracyPass ? '✅' : '❌';
        const libDisplay = isBaseline ? `**${mark} ${library}**` : `${mark} ${library}`;
        const sentCell =
          result.requestCount === result.requestsCompleted
            ? fmt(result.requestCount)
            : `${fmt(result.requestCount)} / ${fmt(result.requestsCompleted)}`;
        const recoveryUs =
          result.recoveryP99 !== undefined ? `${fmtLatencyUs(result.recoveryP99 / 1000)}${result.jitterContaminated ? ' ⚠' : ''}` : '-';
        lines.push(
          [
            `| ${sceneCell}`,
            libDisplay,
            sentCell,
            fmt(result.framesCorrect),
            fmt(result.errors),
            fmt(result.framesExtra),
            recoveryUs,
            fmt(result.maxCpuTimeUs),
            fmt(result.netHeapGrowthKB, 2),
          ].join(' | ') + ' |',
        );
      });
    }
    lines.push('');
  }

  lines.push('### Scene key');
  lines.push('');
  const seen = new Set<string>();
  for (const scene of context.chaos.scenes) {
    if (seen.has(scene.shortLabel)) {
      continue;
    }
    seen.add(scene.shortLabel);
    lines.push(`- \`${scene.shortLabel}\` — ${scene.description}`);
  }
  lines.push('');
  return lines.join('\n');
}

function renderTransportSuite(context: ReportContext): string {
  if (!context.transportSuite) {
    return '';
  }
  const { sequential, multiconn } = context.transportSuite;

  /** Format an Ops/sec ratio against the baseline; emits `<0.01x` for tiny values. */
  function fmtRatio(value: number, baseline: number): string {
    if (!baseline || !Number.isFinite(baseline) || !Number.isFinite(value)) {
      return '-';
    }
    const r = value / baseline;
    if (r > 0 && r < 0.01) {
      return '<0.01x';
    }
    return `${r.toFixed(2)}x`;
  }

  interface Row {
    opsPerSecond: number;
    latency?: { p50: number; p99: number };
    cpu: { usPerOp: number };
  }

  /** Render a single transport block (one or more libraries). Group head row holds Transport. */
  function renderGroup(transport: string, group: Record<string, Row>): string[] {
    const entries = Object.entries(group);
    if (entries.length === 0) {
      return [];
    }
    // Stable order: njs-modbus first (baseline), then alphabetical.
    entries.sort(([a], [b]) => {
      if (a === 'njs-modbus') {
        return -1;
      }
      if (b === 'njs-modbus') {
        return 1;
      }
      return a.localeCompare(b);
    });
    const baseline = group['njs-modbus']?.opsPerSecond ?? 0;
    const winner = entries.reduce(
      (best, [lib, r]) => (r.opsPerSecond > (best[1]?.opsPerSecond ?? -Infinity) ? [lib, r] : best),
      ['', { opsPerSecond: -Infinity } as Row],
    )[0];

    const out: string[] = [];
    entries.forEach(([library, result], idx) => {
      const isBaseline = library === 'njs-modbus';
      const isWinner = library === winner;
      const transportCell = idx === 0 ? `**${transport}**` : '';
      const libCell = `${library}${isWinner ? ' 🏆' : ''}`;
      const opsStr = fmtRate(result.opsPerSecond);
      const ratioStr = isBaseline ? '1.00x' : fmtRatio(result.opsPerSecond, baseline);
      // Baseline row: bold the Library / Ops/sec / vs Baseline cells (the trophy stays outside the bold span if present).
      const libDisplay = isBaseline ? `**${library}**${isWinner ? ' 🏆' : ''}` : libCell;
      const opsDisplay = isBaseline ? `**${opsStr}**` : opsStr;
      const ratioDisplay = isBaseline ? `**${ratioStr}**` : ratioStr;
      out.push(
        `| ${transportCell} | ${libDisplay} | ${opsDisplay} | ${ratioDisplay} | ${fmtLatencyUs(result.latency?.p50)} | ${fmtLatencyUs(result.latency?.p99)} | ${fmt(result.cpu.usPerOp, 2)} |`,
      );
    });
    return out;
  }

  const header = '| Transport | Library | Ops/sec | vs Baseline | P50 (µs) | P99 (µs) | CPU (µs/op) |';
  const sep = '|-----------|---------|---------|-------------|----------|----------|-------------|';

  const lines = [
    '## Transport Suite',
    '',
    'End-to-end FC03 (read 50 holding registers) over real transports. TCP runs over loopback (`127.0.0.1`); RTU and ASCII run over a `socat` PTY pair paced to a 115200-baud line, so serial throughput is bounded by the byte-time RTT, not by the library.',
    '',
    "`vs Baseline` compares each library's Ops/sec to njs-modbus in the same row group; 🏆 marks the highest Ops/sec within a group regardless of library.",
    '',
    `### Sequential (depth=${sequential.depth})`,
    '',
    'One master, one connection, awaits each response before issuing the next request. Reflects single-request round-trip cost; P99 surfaces tail jitter that Avg would mask.',
    '',
    header,
    sep,
  ];
  for (const transport of ['tcp', 'rtu', 'ascii'] as const) {
    lines.push(...renderGroup(transport.toUpperCase(), sequential[transport]));
  }
  lines.push('');
  lines.push(`### Multi-connection (connections=${multiconn.connections})`);
  lines.push('');
  lines.push(
    `${multiconn.connections} independent TCP connections, each issuing depth-1 requests in parallel. Serial transports are skipped — RTU/ASCII share a single physical line and cannot host independent masters.`,
  );
  lines.push('');
  lines.push(header);
  lines.push(sep);
  lines.push(...renderGroup('TCP', multiconn.tcp));
  lines.push('');
  return lines.join('\n');
}

function renderAllFcs(context: ReportContext): string {
  const sections: string[] = [];
  const normal = context.allFcsNormal;
  const max = context.allFcsMax;

  /** Format an Ops/sec ratio against the baseline; emits `<0.01x` for tiny values. */
  function fmtRatio(value: number, baseline: number): string {
    if (!baseline || !Number.isFinite(baseline) || !Number.isFinite(value)) {
      return '-';
    }
    const r = value / baseline;
    if (r > 0 && r < 0.01) {
      return '<0.01x';
    }
    return `${r.toFixed(2)}x`;
  }

  /** Strip the `FC` prefix from labels like `FC01 Read Coils` → `01 Read Coils`. */
  function fcShortLabel(label: string): string {
    return label.replace(/^FC0*(\d+)/i, (_, n: string) => n.padStart(2, '0'));
  }

  for (const [label, payloadNote, data] of [
    [
      'Normal payload',
      'Read 100 coils / 50 registers, write 100 coils / 50 registers, mask write a single register, issue FC08/0 return-query-data diagnostic. Per-FC TCP throughput; loopback only.',
      normal,
    ],
    [
      'Max payload',
      'Read 2000 coils / 125 registers, write 1968 coils / 125 registers; FC08/0 uses its standard 2-byte query payload. Stresses encode/decode against the protocol upper bound.',
      max,
    ],
  ] as const) {
    if (!data) {
      continue;
    }
    sections.push(`### All Function Codes — ${label}`);
    sections.push('');
    sections.push(payloadNote);
    sections.push('');
    sections.push('| Function Code | Library | Ops/sec | vs Baseline | P50 (µs) | P99 (µs) | CPU (µs/op) | GC (ns/op) |');
    sections.push('|---------------|---------|---------|-------------|----------|----------|-------------|------------|');

    // Group summary entries by FC label (preserves coordinator order: FC01, FC02, ...).
    const byFc = new Map<string, typeof data.summary>();
    for (const entry of data.summary) {
      const list = byFc.get(entry.fc);
      if (list) {
        list.push(entry);
      } else {
        byFc.set(entry.fc, [entry]);
      }
    }

    for (const [fcLabel, entries] of byFc) {
      // Stable order: njs-modbus first (baseline), then alphabetical.
      entries.sort((a, b) => {
        if (a.library === 'njs-modbus') {
          return -1;
        }
        if (b.library === 'njs-modbus') {
          return 1;
        }
        return a.library.localeCompare(b.library);
      });
      const baseline = entries.find((e) => e.library === 'njs-modbus')?.opsPerSecond ?? 0;
      const winnerLib = entries.reduce((best, e) => (e.opsPerSecond > best.opsPerSecond ? e : best), entries[0]).library;

      entries.forEach((entry, idx) => {
        const isBaseline = entry.library === 'njs-modbus';
        const isWinner = entry.library === winnerLib;
        const fcCell = idx === 0 ? `**${fcShortLabel(fcLabel)}**` : '';
        const opsStr = fmtRate(entry.opsPerSecond);
        const ratioStr = isBaseline ? '1.00x' : fmtRatio(entry.opsPerSecond, baseline);
        const libDisplay = isBaseline ? `**${entry.library}**${isWinner ? ' 🏆' : ''}` : `${entry.library}${isWinner ? ' 🏆' : ''}`;
        const opsDisplay = isBaseline ? `**${opsStr}**` : opsStr;
        const ratioDisplay = isBaseline ? `**${ratioStr}**` : ratioStr;
        sections.push(
          `| ${fcCell} | ${libDisplay} | ${opsDisplay} | ${ratioDisplay} | ${fmt(entry.p50)} | ${fmt(entry.p99)} | ${fmt(entry.cpuUsPerOp, 2)} | ${fmt(entry.gcNsPerOp)} |`,
        );
      });
    }
    sections.push('');
  }

  if (sections.length === 0) {
    return '';
  }

  const intro = [
    '## All Function Codes',
    '',
    'Per-function-code TCP throughput. Each (FC, library) cell runs in its own worker against a fresh server on a dedicated port, so workers never share an event loop. FC08/17/22/23/43 are njs-modbus-only (jsmodbus has no client implementation); modbus-serial omits FC08/17/22/23.',
    '',
    "`vs Baseline` compares each library's Ops/sec to njs-modbus in the same FC group; 🏆 marks the highest Ops/sec within a group regardless of library.",
    '',
  ].join('\n');

  // Normal vs Max comparison — only emitted when both payload sets exist.
  if (normal && max) {
    const cmp = renderNormalVsMax(normal, max, fcShortLabel);
    if (cmp) {
      sections.push(cmp);
    }
  }

  return intro + '\n' + sections.join('\n');
}

/** Render the "Normal vs Max" delta table; pairs (fc, library) across the two payload sets. */
function renderNormalVsMax(
  normal: NonNullable<ReportContext['allFcsNormal']>,
  max: NonNullable<ReportContext['allFcsMax']>,
  fcShortLabel: (label: string) => string,
): string {
  /** `before → after (↑N% | ↓N%)`; `higherIsBetter` flips arrow direction. */
  function delta(before: number, after: number, higherIsBetter: boolean, fmtVal: (n: number) => string): string {
    const beforeStr = fmtVal(before);
    const afterStr = fmtVal(after);
    if (!before) {
      return `${beforeStr} → ${afterStr}`;
    }
    const pct = ((after - before) / before) * 100;
    const better = higherIsBetter ? pct >= 0 : pct <= 0;
    const arrow = better ? '↑' : '↓';
    return `${beforeStr} → ${afterStr} (${arrow}${Math.abs(pct).toFixed(1)}%)`;
  }

  // Index Max by (fc, library) for O(1) pairing.
  const maxIndex = new Map<string, FcSummaryEntry>();
  for (const e of max.summary) {
    maxIndex.set(`${e.fc}__${e.library}`, e);
  }

  // Group normal entries by FC, preserving order.
  const byFc = new Map<string, FcSummaryEntry[]>();
  for (const e of normal.summary) {
    const list = byFc.get(e.fc);
    if (list) {
      list.push(e);
    } else {
      byFc.set(e.fc, [e]);
    }
  }

  const lines: string[] = [
    '### Normal vs Max payload',
    '',
    'Pairs each (FC, library) cell across the Normal and Max payload runs and reports the relative change. `↑` = the metric moved in the better direction (Ops/sec up, or CPU/GC/P99 down); `↓` = worse. Larger payloads cost encode/decode time, so dropping ops/sec and rising P99 are expected.',
    '',
    '| Function Code | Library | Ops/sec | CPU (µs/op) | GC (ns/op) | P99 (µs) |',
    '|---------------|---------|---------|-------------|------------|----------|',
  ];

  for (const [fcLabel, entries] of byFc) {
    // Same library order as the main FC tables: njs-modbus first, then alphabetical.
    entries.sort((a, b) => {
      if (a.library === 'njs-modbus') {
        return -1;
      }
      if (b.library === 'njs-modbus') {
        return 1;
      }
      return a.library.localeCompare(b.library);
    });
    let firstRow = true;
    for (const norm of entries) {
      const maxEntry = maxIndex.get(`${norm.fc}__${norm.library}`);
      if (!maxEntry) {
        continue;
      }
      const isBaseline = norm.library === 'njs-modbus';
      const fcCell = firstRow ? `**${fcShortLabel(fcLabel)}**` : '';
      firstRow = false;
      const libCell = isBaseline ? `**${norm.library}**` : norm.library;
      lines.push(
        [
          `| ${fcCell}`,
          libCell,
          delta(norm.opsPerSecond, maxEntry.opsPerSecond, true, (n) => fmtRate(n)),
          delta(norm.cpuUsPerOp, maxEntry.cpuUsPerOp, false, (n) => fmt(n, 2)),
          delta(norm.gcNsPerOp, maxEntry.gcNsPerOp, false, (n) => fmt(n)),
          delta(norm.p99, maxEntry.p99, false, (n) => fmt(n)),
        ].join(' | ') + ' |',
      );
    }
  }

  lines.push('');
  return lines.join('\n');
}

function renderDiagnostics(context: ReportContext): string {
  const lines: string[] = ['## Measurement Confidence & Diagnostics', ''];

  /** Aggregate sampleStats across a flat list of results. */
  function summarize(results: { sampleStats: { seen: number; capacity: number; overflowed: boolean; outliersRemoved: number } }[]): {
    count: number;
    totalSeen: number;
    overflowed: number;
    outliersRemoved: number;
  } {
    return results.reduce(
      (acc, r) => {
        acc.count++;
        acc.totalSeen += r.sampleStats.seen;
        acc.outliersRemoved += r.sampleStats.outliersRemoved;
        if (r.sampleStats.overflowed) {
          acc.overflowed++;
        }
        return acc;
      },
      { count: 0, totalSeen: 0, overflowed: 0, outliersRemoved: 0 },
    );
  }

  function fmtMillions(n: number): string {
    if (n >= 1_000_000) {
      return `${(n / 1_000_000).toFixed(1)} M`;
    }
    if (n >= 1_000) {
      return `${(n / 1_000).toFixed(1)} k`;
    }
    return fmt(n);
  }

  /** Emit one diagnostic line; safe to call with an empty list. */
  function pushSection(title: string, results: Parameters<typeof summarize>[0]): void {
    if (results.length === 0) {
      return;
    }
    const s = summarize(results);
    const overflowFrac = `${s.overflowed}/${s.count}`;
    const outliersPct = s.totalSeen > 0 ? ((s.outliersRemoved / s.totalSeen) * 100).toFixed(2) : '0.00';
    lines.push(
      `- **${title}**: ${s.count} test${s.count === 1 ? '' : 's'}, ${fmtMillions(s.totalSeen)} samples collected; ${overflowFrac} overflowed reservoir (cap 100,000); ${outliersPct}% outliers removed (IQR 1.5×).`,
    );
  }

  lines.push('### Sample integrity');
  lines.push('');

  if (context.encodeDecode) {
    pushSection(
      'Encode/Decode micro-benchmark',
      context.encodeDecode.suites.flatMap((s) => Object.values(s.metrics)),
    );
  }

  if (context.transportSuite) {
    const t = context.transportSuite;
    pushSection('Transport suite', [
      ...Object.values(t.sequential.tcp),
      ...Object.values(t.sequential.rtu),
      ...Object.values(t.sequential.ascii),
      ...Object.values(t.multiconn.tcp),
    ]);
  }

  for (const [label, data] of [
    ['All Function Codes (Normal)', context.allFcsNormal],
    ['All Function Codes (Max)', context.allFcsMax],
  ] as const) {
    if (data) {
      pushSection(
        label,
        data.fcs.flatMap((f) => Object.values(f.metrics)),
      );
    }
  }

  if (context.chaos) {
    pushSection(
      'Chaos scenes',
      context.chaos.scenes.flatMap((s) => Object.values(s.metrics)),
    );
  }

  // Chaos resilience runtime — circuit-breaker trips and jitter flags by scene.
  if (context.chaos) {
    lines.push('');
    lines.push('### Chaos resilience runtime');
    lines.push('');

    const tripped: { scene: string; protocol: string; library: string }[] = [];
    const jittered: { scene: string; protocol: string; library: string }[] = [];
    let totalCells = 0;
    for (const scene of context.chaos.scenes) {
      for (const [library, result] of Object.entries(scene.metrics)) {
        totalCells++;
        if (result.circuitBreakerTripped) {
          tripped.push({ scene: scene.shortLabel, protocol: scene.protocol, library });
        }
        if (result.jitterContaminated) {
          jittered.push({ scene: scene.shortLabel, protocol: scene.protocol, library });
        }
      }
    }

    /** Group cells by protocol/library so we don't list every (scene, lib) row. */
    function summarizeFlags(rows: { scene: string; protocol: string; library: string }[]): string {
      if (rows.length === 0) {
        return 'none';
      }
      const grouped = new Map<string, string[]>();
      for (const r of rows) {
        const key = `${r.protocol}/${r.library}`;
        const list = grouped.get(key);
        if (list) {
          list.push(r.scene);
        } else {
          grouped.set(key, [r.scene]);
        }
      }
      return [...grouped.entries()].map(([k, v]) => `${k}: ${v.join(', ')}`).join('; ');
    }

    lines.push(`- **Circuit breaker tripped**: ${tripped.length}/${totalCells} (scene, library) cells — ${summarizeFlags(tripped)}.`);
    lines.push(`- **Jitter contamination flagged**: ${jittered.length}/${totalCells} cells — ${summarizeFlags(jittered)}.`);
  }

  lines.push('');
  return lines.join('\n');
}

export function renderPresentationReport(context: ReportContext): string {
  return [
    renderHeader(context),
    renderEnvironment(context),
    renderVersions(context),
    renderMethodology(),
    renderEncodeDecode(context),
    renderTransportSuite(context),
    renderAllFcs(context),
    renderChaos(context),
    renderDiagnostics(context),
  ].join('\n');
}
