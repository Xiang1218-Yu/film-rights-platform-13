import { useCallback, useEffect, useMemo, useState } from 'react';

/* ---------------- 类型 ---------------- */

type Project = { id: string; title: string; status: string; deliveryDate: string };
type Summary = {
  planned: number; forecast: number; actual: number; variance: number; utilization: number;
  committed: number; contractExposure: number; assetCount: number; pendingApprovals: number;
  highRiskLines: { subcategory: string; forecast: number; planned: number }[];
  lines: { id: string; category: string; subcategory: string; planned: number; forecast: number; actual: number; risk: string }[];
  contracts: { vendor: string; scope: string; committed: number; paid: number; milestones: { name: string; due: string; status: string }[] }[];
  assets: { id: string; name: string; type: string; version: number; status: string; availableTo: string }[];
  approvals: { id: string; title: string; status: string; approver: string }[];
  project: Project;
};

type Slice = { territories: string[]; platforms: string[]; tags: string[]; from: string; to: string; exceptionIds?: string[] };
type Phase = 'pending' | 'scheduled' | 'active' | 'rejected' | 'revoked' | 'expired' | 'stale' | 'timedout';
type ExceptionView = {
  id: string; conflictFingerprint: string; assetIds: [string, string]; assetVersions: [number, number];
  scope: { territories: string[]; platforms: string[]; tags: string[]; dates: { from: string; to: string } };
  justification: string; requestedBy: string; approver: string; status: string; phase: Phase;
  createdAt: string; slaDueAt: string; revision: number; decisionComment?: string;
  effectivenessReason?: string; ineffectivenessReason?: string;
};
type ConflictView = {
  fingerprint: string; severity: 'critical' | 'warning'; pair: [string, string]; names: [string, string];
  versions: [number, number]; territories: string[]; platforms: string[]; tags: string[];
  window: { from: string; to: string };
  suppression: 'open' | 'partial' | 'full';
  residualSlices: Slice[]; coveredSlices: Slice[]; historicalSlices: Slice[];
  exceptions: ExceptionView[];
};
type DashboardRow = {
  id: string; title: string; status: string; forecast: number; variance: number; pendingApprovals: number;
  rights: { totalConflicts: number; realRisk: number; openConflicts: number; partialConflicts: number; exceptedConflicts: number; pendingExceptions: number; expiringSoon: number };
};
type PreflightReport = {
  target: { territories: string[]; platforms: string[]; window: { from: string; to: string } };
  verdict: 'clean' | 'exception' | 'blocked'; at: string; conflictCount: number; blockedCount: number;
  usedExceptions: string[]; conflicts: (ConflictView & { severity: 'critical' | 'warning' })[];
};
type Dimensions = { territories: string[]; platforms: string[]; globalTerritory: string; allPlatforms: string };

/* ---------------- 基础工具 ---------------- */

const money = (n: number) => `¥${(n / 10000).toFixed(0)}万`;
const api = '/api';
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${api}${path}`, init);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message || `请求失败 (${response.status})`);
  return body as T;
}
const sliceText = (s: Slice) =>
  `${s.from} → ${s.to} · ${s.territories.join('/')} · ${s.platforms.join('/')}${s.tags.length ? ` · ${s.tags.join('、')}` : ''}`;

const phaseLabel: Record<Phase, string> = {
  pending: '待审批', scheduled: '已批准·未生效', active: '生效中', rejected: '已驳回',
  revoked: '已撤销', expired: '已到期', stale: '版本失效', timedout: '审批超时',
};

/* ---------------- 主应用 ---------------- */

export default function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [selected, setSelected] = useState('PRJ-001');
  const [summary, setSummary] = useState<Summary>();
  const [conflicts, setConflicts] = useState<ConflictView[]>([]);
  const [exceptions, setExceptions] = useState<ExceptionView[]>([]);
  const [dashboard, setDashboard] = useState<DashboardRow[]>([]);
  const [dimensions, setDimensions] = useState<Dimensions>();
  const [tab, setTab] = useState<'overview' | 'budget' | 'rights'>('overview');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (id = 'PRJ-001') => {
    setError('');
    try {
      const items = await request<Project[]>('/projects');
      const active = items.find((item) => item.id === id) ?? items[0];
      if (!active) throw new Error('服务端没有返回项目数据');
      const [s, c, e, d, dims] = await Promise.all([
        request<Summary>(`/projects/${active.id}/summary`),
        request<ConflictView[]>(`/projects/${active.id}/rights/conflicts`),
        request<ExceptionView[]>(`/projects/${active.id}/rights/exceptions`),
        request<DashboardRow[]>('/rights/dashboard'),
        request<Dimensions>('/rights/dimensions'),
      ]);
      setProjects(items);
      setSelected(active.id);
      setSummary(s);
      setConflicts(c);
      setExceptions(e);
      setDashboard(d);
      setDimensions(dims);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法连接制作服务');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const flash = (ok: string, err?: unknown) => {
    if (err) setError(err instanceof Error ? err.message : '操作失败');
    else setMessage(ok);
  };

  const approve = async (id: string) => {
    try {
      await request(`/approvals/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'approved', comment: '在控制台完成复核' }) });
      flash('审批已通过，审计事件已写入');
      await load(selected);
    } catch (reason) { flash('', reason); }
  };

  const decideException = async (item: ExceptionView, decision: 'approved' | 'rejected') => {
    const comment = decision === 'approved'
      ? (window.prompt('批准意见（留空使用默认）', '同意按申请范围抑制匹配冲突') ?? '')
      : (window.prompt('驳回理由') ?? '');
    if (decision === 'rejected' && !comment.trim()) { setError('驳回必须填写理由'); return; }
    try {
      await request(`/rights/exceptions/${item.id}/decision`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision, comment, expectedRevision: item.revision }),
      });
      flash(decision === 'approved' ? '例外已批准：只抑制申请范围，不改变冲突事实' : '例外已驳回，冲突风险保持');
      await load(selected);
    } catch (reason) { flash('', reason); }
  };

  const revokeException = async (item: ExceptionView) => {
    const reason = window.prompt(`撤销 ${item.id} 的理由（风险将立即恢复并留痕）`);
    if (!reason?.trim()) { setError('撤销必须填写理由'); return; }
    try {
      await request(`/rights/exceptions/${item.id}/revoke`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason }),
      });
      flash('例外已撤销：冲突风险恢复，交付预检将重新阻断');
      await load(selected);
    } catch (reason) { flash('', reason); }
  };

  const bumpVersion = async (assetId: string) => {
    if (!window.confirm(`为 ${assetId} 发布新版本？旧版本上的未决/已批准版权例外将立即失效，不随版本延续。`)) return;
    try {
      await request(`/assets/${assetId}/version`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ actor: '当前用户' }) });
      flash('资产已换版，旧版权例外标记为版本失效（stale）');
      await load(selected);
    } catch (reason) { flash('', reason); }
  };

  const rights = dashboard.find((row) => row.id === selected)?.rights;
  const variancePct = useMemo(() => summary ? Math.round(summary.variance / summary.planned * 100) : 0, [summary]);

  if (loading && !summary) return <main className="connection-state"><div className="loading">正在载入制作控制台…</div><small>正在通过 Vite API 代理连接本地制作服务</small></main>;
  if (!summary) return <main className="connection-state"><h2>无法连接制作服务</h2><p>{error || '服务端没有返回项目数据。'}</p><p>请从项目根目录运行 <code>npm run dev</code>，确认前端和 API 4104 均已启动。</p><button onClick={() => void load(selected)}>重新连接</button></main>;

  return <main>
    <header>
      <div>
        <div className="eyebrow">STUDIO OPS / RIGHTS &amp; FINANCE CONTROL</div>
        <h1>FrameLedger <span>影视制作预算与资产版权协同</span></h1>
        <p>版权冲突不会因审批而消失：法务只能发起<b className="hl">有期限、可撤销</b>的范围例外；批准后只抑制匹配切片，到期 / 撤销 / 换版立即恢复风险。</p>
      </div>
      <div className="header-actions">
        <select value={selected} onChange={(e) => { setSelected(e.target.value); void load(e.target.value); }}>
          {projects.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
        </select>
        <span className="live"><i /> LIVE CONTROL</span>
      </div>
    </header>
    {message && <div className="toast" onClick={() => setMessage('')}>{message} ×</div>}
    {error && <div className="toast error-toast" onClick={() => setError('')}>{error} ×</div>}

    <section className="kpis">
      <div><small>FORECAST COST</small><b>{money(summary.forecast)}</b><span>预算偏差 <em className={summary.variance > 0 ? 'bad' : ''}>{variancePct}%</em></span></div>
      <div><small>COMMITTED</small><b>{money(summary.committed)}</b><span>已锁定供应商与合同</span></div>
      <div><small>ASSET REGISTER</small><b>{summary.assetCount}<em> 个</em></b><span>版本与交付状态纳管</span></div>
      <div>
        <small>RIGHTS RISK</small>
        <b className={rights && rights.realRisk > 0 ? 'bad' : ''}>{rights?.realRisk ?? 0}<em> 项真实风险</em></b>
        <span>{rights?.openConflicts ?? 0} 未缓解 · {rights?.partialConflicts ?? 0} 部分残差 · <em className="except">{rights?.exceptedConflicts ?? 0} 凭例外放行</em></span>
      </div>
    </section>

    <nav className="tabs">
      <button className={tab === 'overview' ? 'active' : ''} onClick={() => setTab('overview')}>项目驾驶舱</button>
      <button className={tab === 'budget' ? 'active' : ''} onClick={() => setTab('budget')}>预算与合同</button>
      <button className={tab === 'rights' ? 'active' : ''} onClick={() => setTab('rights')}>版权冲突与例外</button>
      <span>交付日 {summary.project.deliveryDate}</span>
    </nav>

    {tab === 'overview' && <OverviewTab
      summary={summary} conflicts={conflicts} rights={rights}
      onApprove={approve} onJumpRights={() => setTab('rights')}
    />}
    {tab === 'budget' && <BudgetTab summary={summary} />}
    {tab === 'rights' && <RightsTab
      conflicts={conflicts} exceptions={exceptions} dimensions={dimensions}
      projectId={selected} deliveryDate={summary.project.deliveryDate} onReload={() => load(selected)} bumpVersion={bumpVersion}
      decide={decideException} revoke={revokeException} flash={flash}
    />}

    <footer>FrameLedger · 例外事件仅追加日志（重启回放恢复）· 到期 / 超时 / 撤销 / 换版自动恢复风险 · 交付预检区分真实无冲突与已批准例外</footer>
  </main>;
}

/* ---------------- 驾驶舱 ---------------- */

function OverviewTab({ summary, conflicts, rights, onApprove, onJumpRights }: {
  summary: Summary; conflicts: ConflictView[]; rights?: DashboardRow['rights'];
  onApprove: (id: string) => void; onJumpRights: () => void;
}) {
  return <div className="grid">
    <section className="panel hero">
      <div className="panel-head">
        <div><div className="eyebrow">PROJECT HEALTH / {summary.project.id}</div><h2>{summary.project.title}</h2></div>
        <span className="badge amber">{summary.project.status.toUpperCase()}</span>
      </div>
      <div className="progress-label"><span>成本消耗 {Math.round(summary.utilization * 100)}%</span><b>{money(summary.actual)} / {money(summary.planned)}</b></div>
      <div className="progress"><i style={{ width: `${Math.min(100, summary.utilization * 100)}%` }} /></div>
      <div className="split">
        <div><small>真实冲突风险（残差）</small><strong className={rights && rights.realRisk > 0 ? 'bad' : ''}>{rights?.realRisk ?? 0}</strong></div>
        <div><small>已批准例外放行（≠无冲突）</small><strong className="except">{rights?.exceptedConflicts ?? 0}</strong></div>
        <div><small>待审例外 / 临期例外</small><strong>{rights?.pendingExceptions ?? 0} / {rights?.expiringSoon ?? 0}</strong></div>
      </div>
      <button className="link-btn" onClick={onJumpRights}>查看冲突明细与例外申请 →</button>
    </section>

    <section className="panel">
      <div className="panel-head"><h3>待审批队列</h3><span>{summary.approvals.filter((a) => a.status === 'pending').length} PENDING</span></div>
      {summary.approvals.map((a) => <div className="approval" key={a.id}>
        <span className={`status ${a.status}`} />
        <div><b>{a.title}</b><small>{a.approver} · {a.id}</small></div>
        {a.status === 'pending' ? <button onClick={() => onApprove(a.id)}>通过</button> : <em>已完成</em>}
      </div>)}
    </section>

    <section className="panel wide">
      <div className="panel-head"><h3>交付风险雷达</h3><span>真实风险 vs 已批准例外</span></div>
      <div className="legend">
        <span><i className="dot open" /> 未缓解（真实风险）</span>
        <span><i className="dot partial" /> 部分残差（真实风险）</span>
        <span><i className="dot full" /> 已被例外完整抑制（非无冲突）</span>
      </div>
      {conflicts.length ? conflicts.map((c) => <div className="risk-row" key={c.fingerprint}>
        <strong className={`supp ${c.suppression}`}>{c.suppression === 'open' ? 'OPEN' : c.suppression === 'partial' ? 'PARTIAL' : 'EXCEPTED'}</strong>
        <div>
          <b>{c.names[0]} <small className="vx">v{c.versions[0]}</small> ↔ {c.names[1]} <small className="vx">v{c.versions[1]}</small></b>
          <small>{c.tags.join('、')} · {c.territories.join('/')} · {c.platforms.join('/')} · {c.window.from}→{c.window.to}</small>
          {c.suppression !== 'full' && c.residualSlices.length > 0 && <small className="residual">残差：{c.residualSlices.map(sliceText).join('；')}</small>}
          {c.coveredSlices.length > 0 && <small className="covered-note">已抑制：{c.coveredSlices.map((s) => sliceText(s)).join('；')}</small>}
        </div>
      </div>) : <div className="empty">当前项目真实无冲突。</div>}
    </section>
  </div>;
}

/* ---------------- 预算 ---------------- */

function BudgetTab({ summary }: { summary: Summary }) {
  return <div className="grid">
    <section className="panel wide">
      <div className="panel-head"><h3>预算版本 / 成本基线</h3><span>实际 + 承诺 + 预测</span></div>
      <div className="table">
        <div className="tr th"><span>科目</span><span>预算</span><span>已承诺</span><span>实际</span><span>预测</span><span>风险</span></div>
        {summary.lines.map((line) => <div className="tr" key={line.id}>
          <span><b>{line.category}</b><small>{line.subcategory}</small></span>
          <span>{money(line.planned)}</span><span>{money(line.planned)}</span><span>{money(line.actual)}</span>
          <span className={line.forecast > line.planned ? 'bad' : ''}>{money(line.forecast)}</span>
          <span className={`risk ${line.risk}`}>{line.risk}</span>
        </div>)}
      </div>
    </section>
    <section className="panel">
      <div className="panel-head"><h3>供应商付款里程碑</h3></div>
      {summary.contracts.map((c) => <div className="contract" key={c.vendor}>
        <b>{c.vendor}</b><small>{c.scope}</small>
        <div className="contract-bar"><i style={{ width: `${Math.round(c.paid / c.committed * 100)}%` }} /></div>
        <span>{money(c.paid)} / {money(c.committed)}</span>
        <em>{c.milestones.filter((m) => m.status !== 'paid').length} 个待结点</em>
      </div>)}
    </section>
  </div>;
}

/* ---------------- 版权页 ---------------- */

function RightsTab({ conflicts, exceptions, dimensions, projectId, deliveryDate, onReload, bumpVersion, decide, revoke, flash }: {
  conflicts: ConflictView[]; exceptions: ExceptionView[]; dimensions?: Dimensions;
  projectId: string; deliveryDate: string; onReload: () => void;
  bumpVersion: (assetId: string) => void;
  decide: (item: ExceptionView, decision: 'approved' | 'rejected') => void;
  revoke: (item: ExceptionView) => void;
  flash: (ok: string, err?: unknown) => void;
}) {
  const [applyingFor, setApplyingFor] = useState<ConflictView>();
  const [preflight, setPreflight] = useState<PreflightReport>();
  const [pfBusy, setPfBusy] = useState(false);
  const [pfForm, setPfForm] = useState({ territories: ['全球'], platforms: ['*'], from: '', to: '' });

  useEffect(() => {
    if (!pfForm.from) {
      const today = new Date().toISOString().slice(0, 10);
      setPfForm((f) => ({ ...f, from: today, to: deliveryDate || today }));
    }
  }, [pfForm.from, deliveryDate]);

  const runPreflight = async () => {
    setPfBusy(true);
    try {
      const report = await request<PreflightReport>(`/projects/${projectId}/rights/preflight`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ territories: pfForm.territories, platforms: pfForm.platforms, dates: { from: pfForm.from, to: pfForm.to } }),
      });
      setPreflight(report);
    } catch (reason) { flash('', reason); } finally { setPfBusy(false); }
  };

  return <div className="grid">
    <section className="panel wide">
      <div className="panel-head">
        <div><h3>交付预检</h3><span>真实无冲突 / 凭已批准例外放行 / 残差阻断 —— 三态分明</span></div>
      </div>
      <div className="pf-form">
        <label>地域
          <select multiple value={pfForm.territories} onChange={(e) => setPfForm({ ...pfForm, territories: [...e.target.selectedOptions].map((o) => o.value) })}>
            <option value="全球">全球（默认）</option>
            {dimensions?.territories.filter((t) => t !== '全球').map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </label>
        <label>平台
          <select multiple value={pfForm.platforms} onChange={(e) => setPfForm({ ...pfForm, platforms: [...e.target.selectedOptions].map((o) => o.value) })}>
            <option value="*">全部平台（默认）</option>
            {dimensions?.platforms.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </label>
        <label>起始 <input type="date" value={pfForm.from} onChange={(e) => setPfForm({ ...pfForm, from: e.target.value })} /></label>
        <label>截止 <input type="date" value={pfForm.to} onChange={(e) => setPfForm({ ...pfForm, to: e.target.value })} /></label>
        <button disabled={pfBusy || !pfForm.from || !pfForm.to} onClick={() => void runPreflight()}>执行预检</button>
      </div>
      {preflight && <PreflightResult report={preflight} />}
    </section>

    <section className="panel wide">
      <div className="panel-head"><h3>版权冲突与匹配范围</h3><span>{conflicts.length} 条冲突 · 按 地域×平台×标签×日期 四维抑制</span></div>
      {conflicts.map((c) => <ConflictCard
        key={c.fingerprint} conflict={c} onApply={() => setApplyingFor(c)} bumpVersion={bumpVersion}
        decide={decide} revoke={revoke}
      />)}
      {!conflicts.length && <div className="empty">当前项目真实无冲突。</div>}
    </section>

    <section className="panel wide">
      <div className="panel-head"><h3>版权例外台账</h3><span>{exceptions.length} 份申请 · 含生效 / 失效理由全留痕</span></div>
      <div className="table exc-table">
        <div className="tr th"><span>例外 / 冲突版本</span><span>阶段</span><span>抑制范围</span><span>理由与留痕</span><span>操作</span></div>
        {exceptions.map((e) => <div className="tr" key={e.id}>
          <span><b>{e.id}</b><small>{e.assetIds[0]}@v{e.assetVersions[0]} ↔ {e.assetIds[1]}@v{e.assetVersions[1]}</small><small>{e.requestedBy} → {e.approver}</small></span>
          <span><span className={`phase ${e.phase}`}>{phaseLabel[e.phase]}</span></span>
          <span><small>{e.scope.dates.from} → {e.scope.dates.to}</small><small>{e.scope.territories.join('/')} · {e.scope.platforms.join('/')}</small></span>
          <span>
            <small className="reason">{e.effectivenessReason || e.ineffectivenessReason}</small>
            {e.decisionComment && <small>审批意见：{e.decisionComment}</small>}
          </span>
          <span className="exc-actions">
            {e.phase === 'pending' && <>
              <button className="mini ok" onClick={() => decide(e, 'approved')}>通过</button>
              <button className="mini bad" onClick={() => decide(e, 'rejected')}>驳回</button>
              <small>SLA {new Date(e.slaDueAt).toLocaleString()}</small>
            </>}
            {(e.phase === 'active' || e.phase === 'scheduled') && <button className="mini bad" onClick={() => revoke(e)}>撤销</button>}
            {['revoked', 'expired', 'rejected', 'timedout', 'stale'].includes(e.phase) && <em className="dead">终态 · 风险恢复</em>}
          </span>
        </div>)}
        {!exceptions.length && <div className="empty">暂无例外申请。</div>}
      </div>
    </section>

    {applyingFor && <ApplyModal
      conflict={applyingFor} dimensions={dimensions} projectId={projectId}
      onClose={() => setApplyingFor(undefined)} onDone={(msg) => { setApplyingFor(undefined); flash(msg); void onReload(); }}
      onError={(err) => flash('', err)}
    />}
  </div>;
}

function PreflightResult({ report }: { report: PreflightReport }) {
  const cls = report.verdict === 'clean' ? 'verdict-clean' : report.verdict === 'exception' ? 'verdict-exception' : 'verdict-blocked';
  const title = report.verdict === 'clean'
    ? 'PASS · 真实无冲突'
    : report.verdict === 'exception'
      ? `PASS WITH EXCEPTION · 凭 ${report.usedExceptions.length} 份已批准例外放行（非无冲突）`
      : `BLOCKED · ${report.blockedCount} 条冲突存在真实残差风险`;
  return <div className={`preflight ${cls}`}>
    <b>{title}</b>
    <small>范围：{report.target.territories.join('/')} · {report.target.platforms.join('/')} · {report.target.window.from}→{report.target.window.to}</small>
    {report.conflicts.map((c) => <div className="pf-conflict" key={c.fingerprint}>
      <strong className={`supp ${c.suppression}`}>{c.suppression.toUpperCase()}</strong>
      <div>
        <b>{c.names[0]} ↔ {c.names[1]}</b>
        {c.residualSlices.length > 0 && <small className="residual">阻断残差：{c.residualSlices.map(sliceText).join('；')}</small>}
        {c.coveredSlices.length > 0 && <small className="covered-note">例外覆盖：{c.coveredSlices.map((s) => `${sliceText(s)} [${(s.exceptionIds ?? []).join(',')}]`).join('；')}</small>}
      </div>
    </div>)}
  </div>;
}

function ConflictCard({ conflict, onApply, bumpVersion, decide, revoke }: {
  conflict: ConflictView; onApply: () => void; bumpVersion: (id: string) => void;
  decide: (item: ExceptionView, decision: 'approved' | 'rejected') => void;
  revoke: (item: ExceptionView) => void;
}) {
  const [showHistory, setShowHistory] = useState(false);
  return <div className={`conflict-card supp-border-${conflict.suppression}`}>
    <div className="cc-head">
      <strong className={`supp ${conflict.suppression}`}>{conflict.suppression === 'open' ? 'OPEN · 真实风险' : conflict.suppression === 'partial' ? 'PARTIAL · 残差风险' : 'FULLY EXCEPTED · 非无冲突'}</strong>
      <span className={`sev ${conflict.severity}`}>{conflict.severity.toUpperCase()}</span>
      <b className="cc-names">{conflict.names[0]} <small className="vx">v{conflict.versions[0]}</small> ↔ {conflict.names[1]} <small className="vx">v{conflict.versions[1]}</small></b>
      <div className="cc-actions">
        <button className="mini" onClick={onApply} disabled={conflict.exceptions.some((e) => e.phase === 'pending')}>法务发起例外</button>
        <button className="mini ghost" onClick={() => bumpVersion(conflict.pair[0])}>{conflict.pair[0]} 换版</button>
        <button className="mini ghost" onClick={() => bumpVersion(conflict.pair[1])}>{conflict.pair[1]} 换版</button>
      </div>
    </div>
    <small className="cc-dim">{conflict.tags.join('、')} · {conflict.territories.join('/')} · {conflict.platforms.join('/')} · {conflict.window.from} → {conflict.window.to}</small>
    {conflict.residualSlices.length > 0 && <div className="slices residual-box">
      <b>真实风险残差</b>
      {conflict.residualSlices.map((s, i) => <small key={i} className="residual">{sliceText(s)}</small>)}
    </div>}
    {conflict.coveredSlices.length > 0 && <div className="slices covered-box">
      <b>已批准例外抑制（冲突事实保留）</b>
      {conflict.coveredSlices.map((s, i) => <small key={i} className="covered-note">{sliceText(s)} [{(s.exceptionIds ?? []).join(', ')}]</small>)}
    </div>}
    {conflict.historicalSlices.length > 0 && <div className="slices history-box">
      <button className="link-btn" onClick={() => setShowHistory(!showHistory)}>{showHistory ? '隐藏' : '查看'}今天之前的历史残差（{conflict.historicalSlices.length} 段，不计入当前风险）</button>
      {showHistory && conflict.historicalSlices.map((s, i) => <small key={i}>{sliceText(s)}</small>)}
    </div>}
    <div className="exc-mini-list">
      {conflict.exceptions.map((e) => <div key={e.id} className={`exc-mini phase-${e.phase}`}>
        <span className={`phase ${e.phase}`}>{phaseLabel[e.phase]}</span>
        <b>{e.id} · rev{e.revision}</b>
        <small>{e.effectivenessReason || e.ineffectivenessReason}</small>
        <span>
          {e.phase === 'pending' && <>
            <button className="mini ok" onClick={() => decide(e, 'approved')}>通过</button>
            <button className="mini bad" onClick={() => decide(e, 'rejected')}>驳回</button>
          </>}
          {(e.phase === 'active' || e.phase === 'scheduled') && <button className="mini bad" onClick={() => revoke(e)}>撤销（恢复风险）</button>}
        </span>
      </div>)}
    </div>
  </div>;
}

function ApplyModal({ conflict, dimensions, projectId, onClose, onDone, onError }: {
  conflict: ConflictView; dimensions?: Dimensions; projectId: string;
  onClose: () => void; onDone: (msg: string) => void; onError: (err: unknown) => void;
}) {
  const today = new Date().toISOString().slice(0, 10);
  const defaultEnd = new Date(Date.now() + 40 * 86400000).toISOString().slice(0, 10);
  const [form, setForm] = useState({
    territories: [...conflict.territories],
    platforms: [...conflict.platforms],
    from: conflict.window.from < today ? today : conflict.window.from,
    to: defaultEnd > conflict.window.to ? conflict.window.to : defaultEnd,
    justification: '',
    approver: '法务负责人',
    requestedBy: '法务-周敏',
  });
  const [busy, setBusy] = useState(false);

  const toggle = (key: 'territories' | 'platforms', value: string) => {
    const list = form[key].includes(value) ? form[key].filter((v) => v !== value) : [...form[key], value];
    setForm({ ...form, [key]: list });
  };

  const submit = async () => {
    setBusy(true);
    try {
      const result = await request<{ deduplicated: boolean }>(`/projects/${projectId}/rights/exceptions`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conflictFingerprint: conflict.fingerprint,
          scope: { territories: form.territories, platforms: form.platforms, tags: [], dates: { from: form.from, to: form.to } },
          justification: form.justification, approver: form.approver, requestedBy: form.requestedBy,
        }),
      });
      onDone(result.deduplicated ? '已存在相同冲突+范围的未决/已批准申请，已复用原单（防重复）' : '例外申请已创建：待指定审批人 48 小时内处理，期间冲突仍为真实风险');
    } catch (err) { onError(err); } finally { setBusy(false); }
  };

  return <div className="modal-backdrop" onClick={onClose}>
    <div className="modal" onClick={(e) => e.stopPropagation()}>
      <div className="panel-head"><h3>发起有期限版权例外</h3><button className="mini ghost" onClick={onClose}>×</button></div>
      <p className="modal-conflict">{conflict.names[0]} ↔ {conflict.names[1]}<br />
        <small>{conflict.tags.join('、')} · {conflict.window.from}→{conflict.window.to}</small></p>
      <div className="form-grid">
        <label>地域（勾选；全球可独立勾选）
          <div className="chips">
            <button type="button" className={`chip ${form.territories.includes(dimensions?.globalTerritory ?? '全球') ? 'on' : ''}`} onClick={() => toggle('territories', dimensions?.globalTerritory ?? '全球')}>全球</button>
            {conflict.territories.map((t) => <button type="button" key={t} className={`chip ${form.territories.includes(t) ? 'on' : ''}`} onClick={() => toggle('territories', t)}>{t}</button>)}
          </div>
        </label>
        <label>平台
          <div className="chips">
            <button type="button" className={`chip ${form.platforms.includes('*') ? 'on' : ''}`} onClick={() => toggle('platforms', '*')}>全部平台</button>
            {conflict.platforms.map((p) => <button type="button" key={p} className={`chip ${form.platforms.includes(p) ? 'on' : ''}`} onClick={() => toggle('platforms', p)}>{p}</button>)}
          </div>
        </label>
        <label>生效起 <input type="date" min={today} value={form.from} onChange={(e) => setForm({ ...form, from: e.target.value })} /></label>
        <label>生效止（最长 90 天短窗） <input type="date" value={form.to} onChange={(e) => setForm({ ...form, to: e.target.value })} /></label>
        <label className="full">业务理由（发行项目 / 平台 / 短日期依据，必填）
          <textarea rows={2} value={form.justification} onChange={(e) => setForm({ ...form, justification: e.target.value })} placeholder="例：上线首月同步许可谈判收尾，版权方邮件确认限窗 40 天" />
        </label>
        <label>法务发起人 <input value={form.requestedBy} onChange={(e) => setForm({ ...form, requestedBy: e.target.value })} /></label>
        <label>指定审批人 <input value={form.approver} onChange={(e) => setForm({ ...form, approver: e.target.value })} /></label>
      </div>
      <div className="modal-actions">
        <small className="warn-note">批准后仅在勾选范围 + 日期内抑制匹配；到期 / 撤销 / 资产换版将自动恢复风险并留痕。</small>
        <button disabled={busy || !form.territories.length || !form.platforms.length || !form.justification.trim()} onClick={() => void submit()}>{busy ? '提交中…' : '提交例外申请'}</button>
      </div>
    </div>
  </div>;
}
