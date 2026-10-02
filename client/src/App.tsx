import { useCallback, useEffect, useMemo, useState } from 'react';

type Project = { id: string; title: string; status: string; deliveryDate: string };
type Summary = {
  planned: number; forecast: number; actual: number; variance: number; utilization: number;
  committed: number; contractExposure: number; assetCount: number; pendingApprovals: number;
  highRiskLines: { subcategory: string }[];
  lines: { id: string; category: string; subcategory: string; planned: number; forecast: number; actual: number; risk: string }[];
  contracts: { vendor: string; scope: string; committed: number; paid: number; milestones: { name: string; due: string; status: string }[] }[];
  assets: { id: string; name: string; type: string; version: number; status: string; availableTo: string }[];
  approvals: { id: string; title: string; status: string; approver: string }[];
  project: Project;
};
type Cell = { tag: string; territory: string; platform: string; windowFrom: string; windowTo: string };
type ConflictStatus = 'open' | 'partial' | 'covered';
type Conflict = {
  fingerprint: string; assetAId: string; assetBId: string; assetAVersion: number; assetBVersion: number;
  assetA: string; assetB: string; severity: string; reason: string; active: boolean;
  cells: Cell[]; openCells: Cell[]; coveredCells: Cell[]; status: ConflictStatus; coveringExceptionIds: string[];
};
type ExStatus = 'pending' | 'approved' | 'rejected' | 'timeout' | 'revoked';
type ExEvent = { at: string; action: string; actor: string; reason: string };
type RightsException = {
  id: string; projectId: string; assetId: string; assetVersion: number;
  territories: string[]; platforms: string[]; validFrom: string; validTo: string;
  reason: string; requestedBy: string; approver: string; status: ExStatus;
  decisionComment?: string; revokeReason?: string; createdAt: string; decidedAt?: string; revokedAt?: string;
  history: ExEvent[];
};
type Overview = {
  rawConflictCount: number; realConflictCount: number; coveredCount: number; partialCount: number;
  conflicts: Conflict[]; exceptions: RightsException[]; pendingExceptions: number; activeExceptions: number; asOf: string;
};
type Scope = { territories: string[]; platforms: string[]; dateFrom: string; dateTo: string };
type Preflight = {
  verdict: 'clear' | 'exceptions' | 'blocked'; realConflicts: number; coveredByExceptions: number;
  conflicts: { fingerprint: string; assetA: string; assetB: string; status: ConflictStatus; coveringExceptionIds: string[] }[];
  stateVersion: number;
};
type Delivery = {
  id: string; status: 'generating' | 'ready' | 'failed'; verdict: string;
  scope: Scope; failureReason?: string; createdAt: string; readyAt?: string;
};
type DashboardRow = {
  id: string; title: string; status: string; pendingApprovals: number;
  rightsConflicts: number; coveredByExceptions: number; partialConflicts: number; pendingExceptions: number;
};

const money = (n: number) => `¥${(n / 10000).toFixed(0)}万`;
const api = '/api';
const ACTOR = '法务总监';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${api}${path}`, init);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error((body as { message?: string }).message || `请求失败 (${response.status})`);
  return body as T;
}
const postJson = <T,>(path: string, body: unknown) =>
  request<T>(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

const statusLabel: Record<ExStatus, string> = {
  pending: '待审批', approved: '已批准生效', rejected: '已拒绝', timeout: '审批超时', revoked: '已撤销/失效',
};
const csClass: Record<ConflictStatus, string> = { open: 'cs-open', partial: 'cs-partial', covered: 'cs-covered' };
const csText: Record<ConflictStatus, string> = {
  open: '真实风险', partial: '部分例外', covered: '已批准例外',
};
const cellKey = (c: Cell) => `${c.territory} · ${c.platform} · ${c.windowFrom}→${c.windowTo}`;
const isCovered = (c: Conflict, cell: Cell) =>
  c.coveredCells.some(x => cellKey(x) === cellKey(cell));

export default function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [selected, setSelected] = useState('PRJ-001');
  const [summary, setSummary] = useState<Summary>();
  const [overview, setOverview] = useState<Overview>();
  const [dashboard, setDashboard] = useState<DashboardRow[]>([]);
  const [deliveries, setDeliveries] = useState<Delivery[]>([]);
  const [tab, setTab] = useState<'overview' | 'budget' | 'rights' | 'delivery'>('overview');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (id = 'PRJ-001') => {
    setError('');
    try {
      const items = await request<Project[]>('/projects');
      const active = items.find(item => item.id === id) ?? items[0];
      if (!active) throw new Error('服务端没有返回项目数据');
      const [s, o, d, dl] = await Promise.all([
        request<Summary>(`/projects/${active.id}/summary`),
        request<Overview>(`/projects/${active.id}/rights/overview`),
        request<DashboardRow[]>('/dashboard'),
        request<Delivery[]>(`/projects/${active.id}/deliveries`),
      ]);
      setProjects(items); setSelected(active.id); setSummary(s); setOverview(o); setDashboard(d); setDeliveries(dl);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法连接制作服务');
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);
  // 轮询：反映过期/超时 sweep 与生成完成
  useEffect(() => {
    const timer = setInterval(() => { void load(selected); }, 4000);
    return () => clearInterval(timer);
  }, [load, selected]);

  const refresh = () => load(selected);
  const flash = (text: string) => { setMessage(text); setTimeout(() => setMessage(''), 3500); };
  const fail = (reason: unknown) => setError(reason instanceof Error ? reason.message : '操作失败');

  const decide = async (exId: string, decision: 'approved' | 'rejected') => {
    try {
      await postJson(`/rights/exceptions/${exId}/decision`, {
        decision, actor: ACTOR, comment: decision === 'approved' ? '控制台批准：按作用域与窗口放行' : '控制台拒绝：作用域或凭证不足',
      });
      flash(decision === 'approved' ? '例外已批准，仅在作用域内抑制匹配' : '例外已拒绝，风险保持开放');
      await refresh();
    } catch (e) { fail(e); }
  };
  const revoke = async (exId: string) => {
    const reason = window.prompt('请记录撤销理由（风险将立即恢复，在途交付可能中止）');
    if (!reason) return;
    try {
      await postJson(`/rights/exceptions/${exId}/revoke`, { actor: ACTOR, reason });
      flash('例外已撤销，匹配格子风险已恢复');
      await refresh();
    } catch (e) { fail(e); }
  };
  const bump = async (assetId: string) => {
    if (!window.confirm('换版后，绑定当前版本的例外将漂移失效且不会自动迁移。确认换版？')) return;
    try {
      const a = await postJson<{ version: number }>(`/assets/${assetId}/bump-version`, { actor: '后期制片', note: '控制台触发换版' });      flash(`资产已换版至 v${a.version}，旧版本例外已失效`);
      await refresh();
    } catch (e) { fail(e); }
  };

  const variancePct = useMemo(() => summary ? Math.round(summary.variance / summary.planned * 100) : 0, [summary]);
  const row = dashboard.find(d => d.id === selected);

  if (loading && !summary) return <main className="connection-state"><div className="loading">正在载入制作控制台…</div><small>正在通过 Vite API 代理连接本地制作服务</small></main>;
  if (!summary || !overview) return <main className="connection-state"><h2>无法连接制作服务</h2><p>{error || '服务端没有返回项目数据。'}</p><p>请从项目根目录运行 <code>npm run dev</code>，确认前端 5173 和 API 4104 均已启动。</p><button onClick={() => void load(selected)}>重新连接</button></main>;

  return <main>
    <header>
      <div>
        <div className="eyebrow">STUDIO OPS / RIGHTS & FINANCE CONTROL</div>
        <h1>FrameLedger <span>有期限、可撤销的版权例外协同</span></h1>
        <p>法务就冲突发起限定项目 / 资产版本 / 地域 / 平台 / 日期的例外申请，指定审批后只抑制匹配格子；过期、撤销、换版自动恢复风险，交付预检严格区分真实无冲突与已批准例外。</p>
      </div>
      <div className="header-actions">
        <select value={selected} onChange={e => { setSelected(e.target.value); void load(e.target.value); }}>{projects.map(p => <option key={p.id} value={p.id}>{p.title}</option>)}</select>
        <span className="live"><i /> LIVE CONTROL</span>
      </div>
    </header>
    {message && <div className="toast" onClick={() => setMessage('')}>{message} ×</div>}
    {error && <div className="toast error-toast" onClick={() => setError('')}>{error} ×</div>}

    <section className="kpis">
      <div><small>FORECAST COST</small><b>{money(summary.forecast)}</b><span>预算偏差 <em className={summary.variance > 0 ? 'bad' : ''}>{variancePct}%</em></span></div>
      <div><small>REAL RIGHTS RISK</small><b className={overview.realConflictCount ? 'bad' : 'ok'}>{overview.realConflictCount}<em> 处</em></b><span>未被例外覆盖的真实冲突</span></div>
      <div><small>APPROVED EXCEPTIONS</small><b className="ok">{overview.activeExceptions}<em> 生效中</em></b><span>{overview.coveredCount} 笔全部覆盖 / {overview.partialCount} 笔部分覆盖</span></div>
      <div><small>QUEUE</small><b>{overview.pendingExceptions + summary.pendingApprovals}<em> 项</em></b><span>{overview.pendingExceptions} 条例外待审 / {summary.pendingApprovals} 个其他审批</span></div>
    </section>

    <nav className="tabs">
      <button className={tab === 'overview' ? 'active' : ''} onClick={() => setTab('overview')}>项目驾驶舱</button>
      <button className={tab === 'budget' ? 'active' : ''} onClick={() => setTab('budget')}>预算与合同</button>
      <button className={tab === 'rights' ? 'active' : ''} onClick={() => setTab('rights')}>版权例外工作台</button>
      <button className={tab === 'delivery' ? 'active' : ''} onClick={() => setTab('delivery')}>交付预检与生成</button>
      <span>评估时点 {overview.asOf} · 交付日 {summary.project.deliveryDate}</span>
    </nav>

    {tab === 'overview' && <div className="grid">
      <section className="panel hero">
        <div className="panel-head"><div><div className="eyebrow">PROJECT HEALTH / {summary.project.id}</div><h2>{summary.project.title}</h2></div><span className="badge amber">{summary.project.status.toUpperCase()}</span></div>
        <div className="progress-label"><span>成本消耗 {Math.round(summary.utilization * 100)}%</span><b>{money(summary.actual)} / {money(summary.planned)}</b></div>
        <div className="progress"><i style={{ width: `${Math.min(100, summary.utilization * 100)}%` }} /></div>
        <div className="split">
          <div><small>真实版权风险</small><strong className={overview.realConflictCount ? 'bad' : 'ok'}>{overview.realConflictCount}</strong></div>
          <div><small>例外抑制（≠无冲突）</small><strong className="ok">{overview.coveredCount + overview.partialCount}</strong></div>
          <div><small>待审批例外</small><strong className={overview.pendingExceptions ? '' : 'muted'}>{overview.pendingExceptions}</strong></div>
        </div>
      </section>
      <section className="panel">
        <div className="panel-head"><h3>待审批队列</h3><span>{overview.pendingExceptions} EXCEPTIONS</span></div>
        {overview.exceptions.filter(e => e.status === 'pending').slice(0, 4).map(e => (
          <div className="approval" key={e.id}>
            <span className="status pending" />
            <div><b>{e.reason}</b><small>{e.id} · {e.approver} 指定审批 · {e.validFrom}→{e.validTo}</small></div>
            <div className="actions">
              <button className="primary" onClick={() => void decide(e.id, 'approved')}>批准</button>
              <button className="danger" onClick={() => void decide(e.id, 'rejected')}>拒绝</button>
            </div>
          </div>
        ))}
        {!overview.pendingExceptions && <div className="empty">暂无待审批例外。</div>}
      </section>
      <section className="panel wide">
        <div className="panel-head"><h3>交付风险雷达（区分真实风险与例外抑制）</h3><span>
          {row ? `${row.rightsConflicts} 真实 · ${row.coveredByExceptions} 全例外 · ${row.partialConflicts} 部分例外` : ''}
        </span></div>
        <div className="legend">
          <span><i style={{ background: '#ff9c8b' }} />open：真实未覆盖冲突</span>
          <span><i style={{ background: '#efc46f' }} />partial：部分格子在已批准例外内</span>
          <span><i style={{ background: '#7bd8bf' }} />covered：全部格子已被例外抑制（非无冲突）</span>
        </div>
        {overview.conflicts.length ? overview.conflicts.map(c => (
          <div className="risk-row" key={c.fingerprint}>
            <strong className={c.severity === 'critical' ? 'critical' : 'warning'}>{c.severity.toUpperCase()}</strong>
            <div>
              <b>{c.assetA} <small style={{ display: 'inline' }}>v{c.assetAVersion}</small> ↔ {c.assetB} <small style={{ display: 'inline' }}>v{c.assetBVersion}</small>
                <span className={`pill cs-${c.status}`} style={{ marginLeft: 10 }}>{csText[c.status]}</span>
              </b>
              <small>{c.reason}；覆盖例外：{c.coveringExceptionIds.length ? c.coveringExceptionIds.join('、') : '无'}</small>
              <div className="cellgrid">{c.cells.map(cell => (
                <span key={cellKey(cell)} className={`cell ${isCovered(c, cell) ? 'covered' : 'open'}`}>
                  {isCovered(c, cell) ? '✓' : '✗'} {cell.territory} · {cell.platform}
                </span>
              ))}</div>
            </div>
          </div>
        )) : <div className="empty">当前项目未发现版权窗口冲突——这是真实无冲突。</div>}
      </section>
    </div>}

    {tab === 'budget' && <div className="grid">
      <section className="panel wide">
        <div className="panel-head"><h3>预算版本 V3 / 成本基线</h3><span>实际 + 承诺 + 预测</span></div>
        <div className="table"><div className="tr th"><span>科目</span><span>预算</span><span>已承诺</span><span>实际</span><span>预测</span><span>风险</span></div>
          {summary.lines.map(line => <div className="tr" key={line.id}><span><b>{line.category}</b><small>{line.subcategory}</small></span><span>{money(line.planned)}</span><span>{money(line.planned)}</span><span>{money(line.actual)}</span><span className={line.forecast > line.planned ? 'bad' : ''}>{money(line.forecast)}</span><span className={`risk ${line.risk}`}>{line.risk}</span></div>)}
        </div>
      </section>
      <section className="panel">
        <div className="panel-head"><h3>供应商付款里程碑</h3></div>
        {summary.contracts.map(c => <div className="contract" key={c.vendor}><b>{c.vendor}</b><small>{c.scope}</small><div className="contract-bar"><i style={{ width: `${Math.round(c.paid / c.committed * 100)}%` }} /></div><span>{money(c.paid)} / {money(c.committed)}</span><em>{c.milestones.filter(m => m.status !== 'paid').length} 个待结点</em></div>)}
      </section>
    </div>}

    {tab === 'rights' && <div className="grid">
      <section className="panel wide">
        <div className="panel-head"><h3>冲突格子与例外作用域</h3><span>只抑制匹配的 项目×版本×地域×平台×日期 格子</span></div>
        {overview.conflicts.map(c => (
          <div className="conflict" key={c.fingerprint}>
            <strong className={c.severity === 'critical' ? 'critical' : 'warning'}>{c.severity}</strong>
            <span className={`pill cs-${c.status}`}>{csText[c.status]}</span>
            <b>{c.assetA} v{c.assetAVersion} ↔ {c.assetB} v{c.assetBVersion}</b>
            <small>{c.reason}</small>
            <div className="cellgrid">{c.cells.map(cell => (
              <span key={cellKey(cell)} className={`cell ${isCovered(c, cell) ? 'covered' : 'open'}`}>
                {isCovered(c, cell) ? '✓ 已抑制' : '✗ 风险开放'} · {cellKey(cell)}
              </span>
            ))}</div>
          </div>
        ))}
        {!overview.conflicts.length && <div className="empty">真实无冲突。</div>}
      </section>

      <ExceptionForm assets={summary.assets} onCreated={refresh} onMessage={flash} onError={fail} projectId={selected} />

      <section className="panel">
        <div className="panel-head"><h3>资产版本</h3><span>换版不迁移例外</span></div>
        {summary.assets.map(a => (
          <div className="approval" key={a.id}>
            <div><b>{a.name}</b><small>{a.id} · v{a.version} · {a.availableTo} 前授权</small></div>
            <button onClick={() => void bump(a.id)}>换版 +1</button>
          </div>
        ))}
      </section>

      <section className="panel wide">
        <div className="panel-head"><h3>例外申请全生命周期</h3><span>{overview.exceptions.length} 条 · 生效与失效理由全程留痕</span></div>
        {overview.exceptions.map(e => <ExceptionCard key={e.id} ex={e} assets={summary.assets} onDecide={decide} onRevoke={revoke} />)}
      </section>
    </div>}

    {tab === 'delivery' && <DeliveryPanel projectId={selected} deliveries={deliveries} onChange={refresh} onMessage={flash} onError={fail} />}

    <footer>FrameLedger · 内存/文件仓储 + REST API · 例外状态机（pending→approved/rejected/timeout；approved→revoked 过期/撤销/换版）· OCC 交付生成 · 重启恢复</footer>
  </main>;
}

function ExceptionCard({ ex, assets, onDecide, onRevoke }: {
  ex: RightsException; assets: Summary['assets'];
  onDecide: (id: string, decision: 'approved' | 'rejected') => void;
  onRevoke: (id: string) => void;
}) {
  const asset = assets.find(a => a.id === ex.assetId);
  const drifted = asset && asset.version !== ex.assetVersion;
  const latest = ex.history[ex.history.length - 1];
  return (
    <div className="exception-card">
      <div className="top">
        <b>{ex.id} · {ex.reason}</b>
        <span className={`pill cs-${ex.status === 'approved' ? 'covered' : ex.status === 'pending' ? 'pending' : 'rejected'}`}>{statusLabel[ex.status]}{drifted ? ' · 版本漂移' : ''}</span>
      </div>
      <div className="meta">
        <span className="tag">{ex.assetId} v{ex.assetVersion}{drifted ? ` → 现 v${asset?.version}` : ''}</span>
        {ex.territories.map(t => <span key={t} className={`tag ${t === '*' ? 'global' : ''}`}>{t === '*' ? '全球' : t}</span>)}
        {ex.platforms.map(p => <span key={p} className={`tag ${p === '*' ? 'global' : ''}`}>{p === '*' ? '全平台' : p}</span>)}
        <span className="tag">{ex.validFrom} → {ex.validTo}</span>
        <span className="tag">申请人 {ex.requestedBy}</span>
        <span className="tag">指定审批 {ex.approver}</span>
      </div>
      {ex.decisionComment && <div className="why">审批意见：{ex.decisionComment}</div>}
      {ex.revokeReason && <div className="why revoke">失效理由：{ex.revokeReason}（{ex.revokedAt?.slice(0, 16).replace('T', ' ')}）</div>}
      {latest && !ex.revokeReason && <div className="why">最近事件：{latest.action} · {latest.reason}</div>}
      <div className="row-actions">
        {ex.status === 'pending' && <>
          <button className="primary" onClick={() => onDecide(ex.id, 'approved')}>以「{ACTOR}」批准</button>
          <button className="danger" onClick={() => onDecide(ex.id, 'rejected')}>拒绝</button>
        </>}
        {ex.status === 'approved' && !drifted && <button className="danger" onClick={() => onRevoke(ex.id)}>撤销例外（恢复风险）</button>}
        {ex.status === 'approved' && drifted && <em className="bad">资产已换版，例外已漂移失效</em>}
      </div>
    </div>
  );
}

function ExceptionForm({ projectId, assets, onCreated, onMessage, onError }: {
  projectId: string; assets: Summary['assets']; onCreated: () => void; onMessage: (m: string) => void; onError: (e: unknown) => void;
}) {
  const today = new Date().toISOString().slice(0, 10);
  const max = new Date(Date.now() + 90 * 86400000).toISOString().slice(0, 10);
  const [form, setForm] = useState({
    assetId: assets[0]?.id ?? '', territories: 'CN', platforms: '影院',
    validFrom: today, validTo: max, reason: '', approver: ACTOR,
  });
  const submit = async () => {
    try {
      const result = await postJson<{ deduplicated: boolean }>(`/projects/${projectId}/rights/exceptions`, {        assetId: form.assetId,
        territories: form.territories.split(/[，,\s]+/).filter(Boolean),
        platforms: form.platforms.split(/[，,\s]+/).filter(Boolean),
        validFrom: form.validFrom, validTo: form.validTo,
        reason: form.reason, requestedBy: '法务-周岚', approver: form.approver,
        clientToken: `ui-${Date.now()}`,
      });
      onMessage(result.deduplicated ? '检测到重复申请，已幂等返回原申请' : '例外申请已提交，等待指定审批人处理');
      setForm(f => ({ ...f, reason: '' }));
      onCreated();
    } catch (e) { onError(e); }
  };
  return (
    <section className="panel">
      <div className="panel-head"><h3>法务发起例外申请</h3><span>有期限 · 可撤销 · 最长 90 天</span></div>
      <div className="form-grid">
        <div className="field full"><label>绑定资产版本（申请时锁定当前版本）</label>
          <select value={form.assetId} onChange={e => setForm({ ...form, assetId: e.target.value })}>
            {assets.map(a => <option key={a.id} value={a.id}>{a.name} v{a.version}</option>)}
          </select>
        </div>
        <div className="field"><label>地域（逗号分隔，* = 全球）</label><input value={form.territories} onChange={e => setForm({ ...form, territories: e.target.value })} /></div>
        <div className="field"><label>平台（逗号分隔，* = 全部）</label><input value={form.platforms} onChange={e => setForm({ ...form, platforms: e.target.value })} /></div>
        <div className="field"><label>生效日</label><input type="date" value={form.validFrom} onChange={e => setForm({ ...form, validFrom: e.target.value })} /></div>
        <div className="field"><label>截止日</label><input type="date" value={form.validTo} onChange={e => setForm({ ...form, validTo: e.target.value })} /></div>
        <div className="field full"><label>申请理由（冲突无法及时消除的原因 / 凭证状态）</label><textarea value={form.reason} onChange={e => setForm({ ...form, reason: e.target.value })} placeholder="例如：音乐同步许可续签中，版权方已邮件确认 30 天过渡…" /></div>
        <div className="field full"><label>指定审批人</label><input value={form.approver} onChange={e => setForm({ ...form, approver: e.target.value })} /></div>
      </div>
      <div className="row-actions"><button className="primary" onClick={() => void submit()}>提交例外申请</button></div>
      <small>相同作用域的待审/已批准申请会被识别为重复申请并幂等返回。</small>
    </section>
  );
}

function DeliveryPanel({ projectId, deliveries, onChange, onMessage, onError }: {
  projectId: string; deliveries: Delivery[]; onChange: () => void; onMessage: (m: string) => void; onError: (e: unknown) => void;
}) {
  const today = new Date().toISOString().slice(0, 10);
  const [scope, setScope] = useState<Scope>({ territories: ['CN'], platforms: ['影院'], dateFrom: today, dateTo: today });
  const [territories, setTerritories] = useState('CN');
  const [platforms, setPlatforms] = useState('影院');
  const [preflight, setPreflight] = useState<Preflight>();

  const runPreflight = async () => {
    const next: Scope = {
      territories: territories.split(/[，,\s]+/).filter(Boolean),
      platforms: platforms.split(/[，,\s]+/).filter(Boolean),
      dateFrom: scope.dateFrom, dateTo: scope.dateTo,
    };
    setScope(next);
    try { setPreflight(await postJson<Preflight>(`/projects/${projectId}/delivery/preflight`, { scope: next })); }
    catch (e) { onError(e); }
  };
  const generate = async () => {
    try {
      await postJson(`/projects/${projectId}/delivery/generate`, { scope, requestedBy: '发行部', clientToken: `ui-${Date.now()}` });
      onMessage('已开始生成；提交前会再次复核，期间撤销/换版将中止生成');
      onChange();
    } catch (e) { onError(e); }
  };

  return <div className="grid">
    <section className="panel">
      <div className="panel-head"><h3>交付预检</h3><span>按发行作用域裁剪格子</span></div>
      <div className="form-grid">
        <div className="field"><label>发行地域（* = 全球）</label><input value={territories} onChange={e => setTerritories(e.target.value)} /></div>
        <div className="field"><label>发行平台（* = 全部）</label><input value={platforms} onChange={e => setPlatforms(e.target.value)} /></div>
        <div className="field"><label>起始日</label><input type="date" value={scope.dateFrom} onChange={e => setScope({ ...scope, dateFrom: e.target.value })} /></div>
        <div className="field"><label>截止日</label><input type="date" value={scope.dateTo} onChange={e => setScope({ ...scope, dateTo: e.target.value })} /></div>
      </div>
      <div className="row-actions"><button className="primary" onClick={() => void runPreflight()}>执行预检</button>
        {preflight && preflight.verdict !== 'blocked' && <button onClick={() => void generate()}>接受结论并生成交付包</button>}
      </div>
      {preflight && <div className={`verdict ${preflight.verdict}`} style={{ marginTop: 14 }}>
        <b>{preflight.verdict === 'clear' ? 'CLEAR · 真实无冲突' : preflight.verdict === 'exceptions' ? 'EXCEPTIONS · 凭已批准例外放行' : 'BLOCKED · 存在真实风险'}</b>
        {preflight.verdict === 'clear' && '作用域内无冲突格子，可放心交付。'}
        {preflight.verdict === 'exceptions' && `作用域内 ${preflight.coveredByExceptions} 笔冲突全部落在已批准例外内——这不是无冲突，请随包登记例外清单与到期日。`}
        {preflight.verdict === 'blocked' && `作用域内 ${preflight.realConflicts} 笔冲突存在未覆盖格子，必须先消除冲突或取得对应作用域的例外。`}
        <div className="meta" style={{ marginTop: 10 }}>
          {preflight.conflicts.map(c => <span key={c.fingerprint} className="tag">{c.assetA} ↔ {c.assetB} · <span className={c.status === 'covered' ? 'ok' : 'bad'}>{csText[c.status]}</span></span>)}
        </div>
      </div>}
    </section>
    <section className="panel">
      <div className="panel-head"><h3>交付包状态</h3><span>生成中撤销会级联中止</span></div>
      {deliveries.length ? deliveries.map(d => (
        <div className="dlv" key={d.id}>
          <div className="top">
            <b>{d.id}</b>
            <span className={`dlv-${d.status}`}>{d.status === 'ready' ? 'READY' : d.status === 'failed' ? 'FAILED' : 'GENERATING…'}</span>
          </div>
          <small>
            {d.scope.territories.join('、')} · {d.scope.platforms.join('、')} · {d.scope.dateFrom}→{d.scope.dateTo}
            <br />预检结论：{d.verdict === 'clear' ? '真实无冲突' : d.verdict === 'exceptions' ? '全部由已批准例外覆盖' : d.verdict}
            {d.failureReason && <><br /><span className="bad">中止理由：{d.failureReason}</span></>}
          </small>
        </div>
      )) : <div className="empty">尚无交付包。</div>}
    </section>
  </div>;
}
