import { useEffect, useMemo, useState } from 'react';
import {
  billingGb, CLOUDFLARE_RATES, DEFAULT_SCENARIO, daysUntil, priceMonth, projectUsage,
  usageFromHistory, type Scenario,
} from '@sr/core';
import { bytes } from '../lib/format.js';
import { PaletteProvider, PalettePicker, Section, usePalette } from '../lib/sections.js';
import { VersionBadge } from './VersionBadge.js';

/**
 * What the database holds, what it is costing, and what it will cost.
 *
 * The rates come from Cloudflare's own pricing pages and carry the date they were read —
 * see CLOUDFLARE_RATES. The arithmetic lives in @sr/core where it is tested against worked
 * examples, because a projection that decides whether to keep recording is exactly the
 * kind of number nobody re-checks once it looks plausible.
 *
 * The frame size is measured, never assumed. Every projection on this page multiplies up
 * from the mean of the frames actually stored, so it answers "what will THIS recorder
 * cost" rather than "what would some recorder cost".
 */

interface History {
  generated_at: string;
  retention_days: number;
  /** Whose usage this is. The page prints it beside every figure. */
  scope: 'account' | 'all';
  window_days: number;
  totals: {
    frames: number;
    bytes: number;
    stored_bytes: number;
    original_bytes: number;
    avg_frame_bytes: number;
    min_frame_bytes: number;
    max_frame_bytes: number;
    sessions: number;
    accounts: number;
    oldest: string | null;
    newest: string | null;
  };
  daily: { day: string; frames: number; bytes: number }[];
}

const usd = (n: number) => `$${n.toFixed(2)}`;
/**
 * Storage in the unit the invoice uses.
 *
 * `bytes()` elsewhere in the app is binary — a 1024-based KB, which is what a file manager
 * shows. Cloudflare bills decimal GB, so anything that sits beside a price says GB the way
 * the bill means it, and says so.
 */
const gb = (b: number) => `${billingGb(b).toFixed(2)} GB`;
const num = (n: number) => Math.round(n).toLocaleString();

export function DatabaseView() {
  const [data, setData] = useState<History | null>(null);
  const [error, setError] = useState<string | null>(null);
  /**
   * Whose usage to show.
   *
   * This page reported "0.16 GB in R2" while the operator view reported "453.9 MB", and
   * both were correct: one counts this account, the other every account. Nothing on either
   * said which, so they read as a contradiction. The scope is now a choice, it is printed
   * beside the number, and account-wide is refused for a non-operator rather than silently
   * narrowed back to your own.
   */
  const [scope, setScope] = useState<'account' | 'all'>('account');
  const [days, setDays] = useState(30);

  useEffect(() => {
    setData(null);
    setError(null);
    let cancelled = false;
    fetch(`/v1/usage/history?days=${days}&scope=${scope}`, { credentials: 'include' })
      .then(async (r) => {
        if (r.status === 401) throw new Error('Sign in to see this account\u2019s usage.');
        if (r.status === 403) throw new Error('Account-wide usage is operator-only.');
        if (!r.ok) throw new Error(`the API answered ${r.status}`);
        return r.json() as Promise<History>;
      })
      .then((d) => { if (!cancelled) setData(d); })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); });
    return () => { cancelled = true; };
  }, [scope, days]);

  return (
    <PaletteProvider>
      <div className="app">
        <header>
          <h1>ScreenRegister <span>\u00b7 database &amp; cost</span></h1>
          <nav>
            <a href="/status" className="button-link">&larr; Status</a>
            <a href="/" className="button-link">Recorder</a>
          </nav>
        </header>

        <div className="db-toolbar">
          <div className="evo-motion" role="group" aria-label="Whose usage">
            <button className={scope === 'account' ? 'on' : ''} onClick={() => setScope('account')}>
              this account
            </button>
            <button className={scope === 'all' ? 'on' : ''} onClick={() => setScope('all')}>
              every account
            </button>
          </div>
          <label className="db-range">
            <span>History window</span>
            <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
              {[7, 14, 30, 60, 90, 180, 365].map((d) => (
                <option key={d} value={d}>last {d} days</option>
              ))}
            </select>
          </label>
          <PalettePicker />
        </div>

        {error && <div className="panel"><div className="banner bad">{error}</div></div>}
        {!data && !error && <div className="empty">Reading usage\u2026</div>}
        {data && <Dashboard h={data} />}
        <VersionBadge />
      </div>
    </PaletteProvider>
  );
}

function Dashboard({ h }: { h: History }) {
  const measured = Math.round(h.totals.avg_frame_bytes) || DEFAULT_SCENARIO.avgFrameBytes;

  const [fps, setFps] = useState(1);
  const [gapS, setGapS] = useState(3);
  const [hours, setHours] = useState(24);
  const [keepOriginal, setKeepOriginal] = useState(false);
  const [plan, setPlan] = useState<'free' | 'paid'>('paid');
  /**
   * How many people record like this at once.
   *
   * Everything downstream scales linearly, which is exactly why it belongs on the page
   * rather than left as an exercise: the difference between one person and a team is the
   * difference between a free tier and a real bill, and multiplying four figures in your
   * head is where planning goes wrong.
   */
  const [users, setUsers] = useState(1);

  const scenario: Scenario = {
    ...DEFAULT_SCENARIO,
    fps,
    hoursPerDay: hours,
    retentionDays: h.retention_days,
    avgFrameBytes: measured,
    minStoreGapMs: gapS * 1000,
    keepOriginal,
    users: Math.max(0, users),
  };
  const usage = useMemo(
    () => projectUsage(scenario),
    [fps, gapS, hours, keepOriginal, measured, h.retention_days, users],
  );
  const bill = useMemo(() => priceMonth(usage, plan), [usage, plan]);

  /**
   * What the account has actually been doing, from the rows rather than from a scenario.
   *
   * Averaged over calendar days in the window, not over the days something happened: an
   * idle Sunday genuinely costs nothing and belongs in the divisor. Both rates are shown,
   * because quietly picking one is how a projection ends up overstating.
   */
  const observed = useMemo(
    () => usageFromHistory(h.daily, {
      days: h.window_days,
      retentionDays: h.retention_days,
      objectsPerFrame: 2,
    }),
    [h],
  );
  const observedBill = useMemo(() => priceMonth(observed.usage, plan), [observed, plan]);

  const r = CLOUDFLARE_RATES;
  const gbNow = billingGb(h.totals.bytes);
  const toFreeCeiling = daysUntil(gbNow, observed.usage.bytesPerDay / 1e9, r.r2.freeStorageGbMonth);
  const rowsPerDay = observed.usage.framesPerDay * 2;
  const writeHeadroom = r.d1.freeDailyRowsWritten > 0
    ? (rowsPerDay / r.d1.freeDailyRowsWritten) * 100 : 0;

  const maxDay = Math.max(1, ...h.daily.map((d) => d.bytes));

  return (
    <>
      {/* --- what is there right now ------------------------------------------------ */}
      <Section n={0} title={h.scope === 'all' ? 'Held right now \u00b7 every account' : 'Held right now \u00b7 this account'}>
        <div className="stats">
          <div className="stat"><b>{gb(h.totals.bytes)}</b><span>in R2 (billed GB)</span></div>
          <div className="stat"><b>{num(h.totals.frames)}</b><span>frames</span></div>
          <div className="stat"><b>{bytes(measured)}</b><span>average frame</span></div>
          <div className="stat"><b>{num(h.totals.sessions)}</b><span>recordings</span></div>
        </div>
        <div className="hint" style={{ marginTop: 10 }}>
          Frames range {bytes(h.totals.min_frame_bytes)} to {bytes(h.totals.max_frame_bytes)}.
          Retention holds {h.retention_days} days, so storage plateaus rather than growing
          without end — the bill is a rolling {h.retention_days} days of frames however long
          the recorder has run.
          {h.scope === 'all'
            ? ` Across ${num(h.totals.accounts)} account${h.totals.accounts === 1 ? '' : 's'}.`
            : ' This account only — switch the scope above for the whole system.'}
          {' '}Read {new Date(h.generated_at).toLocaleString()}.
          <br /><br />
          <b>On units:</b> every GB beside a price on this page is a billing GB of 10<sup>9</sup>
          bytes, which is what Cloudflare invoices. The operator view counts in binary MB
          (2<sup>20</sup>), so the same bytes read about 7% larger there. Same data, two
          conventions — this page uses the one the bill means.
        </div>
      </Section>

      {/* --- live monitoring against the caps that actually bite --------------------- */}
      <Section n={1} title="Live monitoring">
        <Gauge
          label="R2 storage" value={gbNow} ceiling={r.r2.freeStorageGbMonth}
          unit="GB" note={`free allowance ${r.r2.freeStorageGbMonth} GB-month`}
        />
        <Gauge
          label="D1 rows written per day" value={rowsPerDay} ceiling={r.d1.freeDailyRowsWritten}
          unit="rows"
          note="one row when a frame arrives, one when retention deletes it — the free cap now FAILS queries, it does not throttle"
        />
        <Gauge
          label="Worker requests per day" value={observed.usage.framesPerDay}
          ceiling={r.workers.freeDailyRequests} unit="requests"
          note="one upload per stored frame"
        />
        <div className="hint" style={{ marginTop: 12 }}>
          Averaged over the last <b>{h.window_days}</b> calendar days, of which{' '}
          <b>{observed.activeDays}</b> had activity:{' '}
          <b>{num(observed.usage.framesPerDay)}</b> frames and{' '}
          <b>{gb(observed.usage.bytesPerDay)}</b> a day, which settles at{' '}
          <b>{gb(observed.usage.steadyStateBytes)}</b> held once the window is full. While it
          is actually running the rate is <b>{num(observed.framesPerActiveDay)}</b> frames a
          day — the bill follows the calendar average, because an idle day genuinely costs
          nothing.
          {Number.isFinite(toFreeCeiling) && toFreeCeiling > 0 && (
            <> At this rate R2&rsquo;s free 10 GB is reached in about{' '}
              <b>{toFreeCeiling < 1 ? 'less than a day' : `${Math.round(toFreeCeiling)} days`}</b>.</>
          )}
          {writeHeadroom > 100 && (
            <> <b style={{ color: 'var(--bad)' }}>D1 writes are at {Math.round(writeHeadroom)}% of the
              free daily cap</b> — on the free plan the recorder stops partway through each day.</>
          )}
        </div>
      </Section>

      {/* --- the next bill ---------------------------------------------------------- */}
      <Section
        n={2}
        title="Next bill, from the measured history"
        aside={
          <div className="evo-motion" role="group" aria-label="Plan">
            <button className={plan === 'free' ? 'on' : ''} onClick={() => setPlan('free')}>free</button>
            <button className={plan === 'paid' ? 'on' : ''} onClick={() => setPlan('paid')}>paid</button>
          </div>
        }
      >
        <div className="hint" style={{ marginTop: 0 }}>
          Projected from what this {h.scope === 'all' ? 'system' : 'account'} actually stored
          over the last <b>{h.window_days} days</b> — {num(observed.totalFrames)} frames across{' '}
          <b>{observed.activeDays}</b> active day{observed.activeDays === 1 ? '' : 's'}, at a
          measured <b>{bytes(observed.avgFrameBytes)}</b> a frame. Change the window above to
          project from a different stretch of history.
        </div>
        <BillTable bill={observedBill} />
      </Section>

      {/* --- scenarios -------------------------------------------------------------- */}
      <Section n={3} title="Consumption simulation">
        <div className="hint" style={{ marginTop: 0, marginBottom: 14 }}>
          Every figure below multiplies up from the <b>{bytes(measured)}</b> mean of the
          frames actually stored here, so it answers what <i>this</i> recorder costs rather
          than what some recorder would. The worst case is assumed throughout: every sampled
          frame different from the last, nothing dropped by the change detector.
        </div>

        <div className="db-knobs">
          <label>
            <span>Capture rate <b>{fps} fps</b></span>
            <input type="range" min={1} max={30} step={1} value={fps}
              onChange={(e) => setFps(Number(e.target.value))} />
          </label>
          <label>
            <span>Minimum gap <b>{gapS === 0 ? 'none' : `${gapS} s`}</b></span>
            <input type="range" min={0} max={30} step={1} value={gapS}
              onChange={(e) => setGapS(Number(e.target.value))} />
          </label>
          <label>
            <span>Recording <b>{hours} h/day</b></span>
            <input type="range" min={1} max={24} step={1} value={hours}
              onChange={(e) => setHours(Number(e.target.value))} />
          </label>
          <label>
            <span>People recording <b>{users}</b></span>
            <input type="number" min={0} max={100000} value={users}
              onChange={(e) => setUsers(Math.max(0, Math.round(Number(e.target.value) || 0)))} />
          </label>
          <label className="db-check">
            <input type="checkbox" checked={keepOriginal}
              onChange={(e) => setKeepOriginal(e.target.checked)} />
            <span>keep the untouched copy (doubles storage)</span>
          </label>
        </div>

        <div className="stats" style={{ marginTop: 14 }}>
          <div className="stat"><b>{num(usage.framesPerDay)}</b><span>frames a day</span></div>
          <div className="stat"><b>{gb(usage.bytesPerDay)}</b><span>a day</span></div>
          <div className="stat"><b>{gb(usage.steadyStateBytes)}</b><span>held at steady state (billed)</span></div>
          <div className="stat"><b>{usd(bill.total)}</b><span>per month</span></div>
        </div>

        {gapS > 0 && fps > 1 && (
          <div className="banner info" style={{ marginTop: 14 }}>
            At a {gapS}-second gap the capture rate stops mattering: nothing can be stored
            closer together than the gap, so {fps} fps and 1 fps cost the same. The gap is
            the governor, not the frame rate.
          </div>
        )}

        <BillTable bill={bill} />
      </Section>

      <Section n={4} title="Where these rates come from">
        <div className="hint" style={{ marginTop: 0 }}>
          Quoted from Cloudflare&rsquo;s own pricing pages on <b>{r.asOf}</b>, not recalled:{' '}
          R2 ${r.r2.storagePerGbMonth}/GB-month, ${r.r2.classAPerMillion}/million writes,
          {' '}{r.r2.freeStorageGbMonth} GB free. D1 ${r.d1.rowsWrittenPerMillion}/million rows
          written past {num(r.d1.includedRowsWritten)}/month, free plan capped at{' '}
          {num(r.d1.freeDailyRowsWritten)} writes and {num(r.d1.freeDailyRowsRead)} reads a day.
          Workers ${r.workers.subscriptionPerMonth}/month plus ${r.workers.requestsPerMillion}/million
          requests past {num(r.workers.includedRequests)}.
          <br /><br />
          R2 rounds every billable quantity <b>up</b> to the next whole unit — their example
          is that one million and one operations bills as two million — and this model does
          the same. Estimates that miss it undercount, and they undercount most at the small
          scale where the answer decides whether you can run at all.
          <br /><br />
          <b>Not included:</b> Worker CPU time, which depends on request shape rather than on
          frame count; Class B reads, which depend on how much playback happens; and D1 rows
          read, which the status page and this page themselves consume. Those are usage you
          drive by looking, not by recording.
        </div>
      </Section>

      {h.daily.length > 0 && (
        <Section n={5} title="Stored per day">
          <div className="db-bars">
            {h.daily.map((d) => (
              <div key={d.day} className="db-bar" title={`${d.day} · ${num(d.frames)} frames · ${bytes(d.bytes)}`}>
                <i style={{ height: `${Math.max(2, (d.bytes / maxDay) * 100)}%` }} />
                <span>{d.day.slice(5)}</span>
              </div>
            ))}
          </div>
        </Section>
      )}
    </>
  );
}

/** A bar against the ceiling that actually matters, rather than against an arbitrary max. */
function Gauge({
  label, value, ceiling, unit, note,
}: { label: string; value: number; ceiling: number; unit: string; note: string }) {
  const pct = ceiling > 0 ? (value / ceiling) * 100 : 0;
  const tone = pct >= 100 ? 'bad' : pct >= 70 ? 'warn' : 'good';
  return (
    <div className="db-gauge">
      <div className="db-gauge-head">
        <b>{label}</b>
        <span className={tone}>
          {unit === 'GB' ? value.toFixed(2) : num(value)} / {num(ceiling)} {unit}
          {' · '}{pct >= 1000 ? '>1000' : Math.round(pct)}%
        </span>
      </div>
      <div className="db-gauge-track">
        <i className={tone} style={{ width: `${Math.min(100, pct)}%` }} />
      </div>
      <div className="hint" style={{ marginTop: 4 }}>{note}</div>
    </div>
  );
}

function BillTable({ bill }: { bill: ReturnType<typeof priceMonth> }) {
  if (bill.plan === 'free') {
    return bill.blocked.length === 0 ? (
      <div className="banner" style={{ background: '#12291d', border: '1px solid #1f5c3c', color: '#9fe6c2', marginTop: 14 }}>
        Fits inside every free allowance. Nothing to pay.
      </div>
    ) : (
      <div className="banner bad" style={{ marginTop: 14 }}>
        <b>This does not run on the free plan.</b>
        <ul style={{ margin: '8px 0 0', paddingLeft: 18 }}>
          {bill.blocked.map((b) => <li key={b}>{b}</li>)}
        </ul>
        <div style={{ marginTop: 8 }}>
          Past these caps Cloudflare returns errors rather than throttling, so the honest
          answer is that the recorder stops — not that it costs nothing.
        </div>
      </div>
    );
  }
  return (
    <div className="table-scroll" style={{ marginTop: 14 }}>
      <table>
        <thead>
          <tr><th>Line</th><th>Used</th><th>Included</th><th>Billed</th><th>Cost</th></tr>
        </thead>
        <tbody>
          {bill.items.map((i) => (
            <tr key={i.label}>
              <td>
                {i.label}
                {i.note && <div className="hint" style={{ margin: 0 }}>{i.note}</div>}
              </td>
              <td>{i.unit === 'GB-month' ? i.quantity.toFixed(2) : num(i.quantity)}</td>
              <td style={{ color: 'var(--dim)' }}>{num(i.included)}</td>
              <td>{i.unit === 'GB-month' ? num(i.billable) : num(i.billable)}</td>
              <td style={{ color: i.cost > 0 ? 'var(--fg)' : 'var(--dim)' }}>{usd(i.cost)}</td>
            </tr>
          ))}
          <tr>
            <td colSpan={4}><b>Total per month</b></td>
            <td><b>{usd(bill.total)}</b></td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
