import {
  type Asset,
  auditEvents,
} from './domain.js';
import { readFileSync, appendFileSync } from 'node:fs';

/* ------------------------------------------------------------------ */
/* 领域类型：冲突、例外、生命周期理由                                    */
/* ------------------------------------------------------------------ */

export const GLOBAL_TERRITORY = '全球';
export const ALL_PLATFORMS = '*';
export const DEFAULT_SLA_HOURS = 48;
export const MAX_WINDOW_DAYS = 90;

export type ExceptionStatus =
  | 'pending' // 待指定审批人处理（有 SLA）
  | 'approved' // 已批准（按 scope 抑制匹配范围；可能是 scheduled/active/expired）
  | 'rejected' // 驳回（终态）
  | 'revoked' // 撤销（终态，风险恢复）
  | 'expired' // 到期（终态，风险恢复）
  | 'stale' // 资产换版 / 冲突消失后失效（终态，须重新申请）
  | 'timedout'; // 超过审批 SLA 未决（终态，风险恢复）

export type ExceptionPhase =
  | 'pending'
  | 'scheduled'
  | 'active'
  | 'rejected'
  | 'revoked'
  | 'expired'
  | 'stale'
  | 'timedout';

export interface DateWindow { from: string; to: string; }
export interface ExceptionScope {
  /** 抑制的地域；['全球'] 表示全球范围 */
  territories: string[];
  /** 抑制的平台；['*'] 表示全部平台 */
  platforms: string[];
  /** 短日期窗口（含端点），服务端强制最长 MAX_WINDOW_DAYS */
  dates: DateWindow;
  /** 抑制的授权标签；空数组表示该冲突的全部重叠标签 */
  tags: string[];
}

export type HistoryAction =
  | 'created' | 'approved' | 'rejected' | 'revoked'
  | 'expired' | 'stale' | 'timedout';

export interface ExceptionHistoryEntry {
  at: string;
  action: HistoryAction;
  actor: string;
  /** 生效 / 失效理由，始终随事件留痕 */
  reason: string;
}

export interface RightsException {
  id: string;
  projectId: string;
  /** 指向被申请的具体冲突指纹（资产对 + 重叠维度） */
  conflictFingerprint: string;
  assetIds: [string, string];
  /** 申请时锁定的资产版本；换版后例外失效 */
  assetVersions: [number, number];
  scope: ExceptionScope;
  justification: string;
  requestedBy: string; // 法务发起人
  approver: string; // 指定审批人
  status: ExceptionStatus;
  createdAt: string;
  decidedAt?: string;
  decisionComment?: string;
  /** pending 状态的审批截止时间，超时自动 timedout */
  slaDueAt: string;
  /** 乐观锁：每次决定 / 撤销 +1，防止撤销与决定并发覆盖 */
  revision: number;
  history: ExceptionHistoryEntry[];
}

export interface ConflictDimension {
  territories: string[];
  platforms: string[];
  window: DateWindow;
  tags: string[];
}

export interface RightsConflict extends ConflictDimension {
  fingerprint: string;
  projectId: string;
  severity: 'critical' | 'warning';
  pair: [string, string];
  names: [string, string];
  versions: [number, number];
  reasons: string[];
}

export interface ScopeSlice {
  territories: string[];
  platforms: string[];
  tags: string[];
  from: string;
  to: string;
}

export interface CoveredSlice extends ScopeSlice {
  exceptionIds: string[];
}

export interface ExceptionView extends RightsException {
  phase: ExceptionPhase;
  /** 批准后在冲突窗口内真正生效的区间 */
  effective?: DateWindow;
  /** 当前为何生效（active / scheduled 时给出抑制说明） */
  effectivenessReason?: string;
  /** 当前为何不抑制（失效 / 待决 / 驳回 / 撤销 / 超时 / 换版） */
  ineffectivenessReason?: string;
}

export interface ConflictView extends RightsConflict {
  /** open：无任何生效抑制；partial：部分抑制；full：从今天起的全部剩余匹配范围被抑制 */
  suppression: 'open' | 'partial' | 'full';
  /** 从今天起未被任何有效例外覆盖的残差范围（真实风险） */
  residualSlices: ScopeSlice[];
  /** 已被批准例外抑制的范围（例外覆盖，不等于无冲突），含今天及未来 */
  coveredSlices: CoveredSlice[];
  /** 今天之前的残差片段：历史窗口，不计入当前风险与放行判定 */
  historicalSlices: ScopeSlice[];
  exceptions: ExceptionView[];
}

/* ------------------------------------------------------------------ */
/* 日期 / 集合工具                                                      */
/* ------------------------------------------------------------------ */

const DAY_MS = 86_400_000;

export const dateKey = (d: Date) => d.toISOString().slice(0, 10);
export const addDays = (key: string, days: number) =>
  dateKey(new Date(Date.parse(`${key}T00:00:00Z`) + days * DAY_MS));

function daysBetween(from: string, to: string) {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

function intersectWindow(a: DateWindow, b: DateWindow): DateWindow | undefined {
  const from = a.from > b.from ? a.from : b.from;
  const to = a.to < b.to ? a.to : b.to;
  return from <= to ? { from, to } : undefined;
}

/** 维度求交；global 为通配值（地域用「全球」，平台用 '*'），任一侧通配都展开为另一侧全集 */
export function intersectList(a: string[], b: string[], global: string): string[] {
  if (a.includes(global) && b.includes(global)) return [global];
  if (a.includes(global)) return [...b];
  if (b.includes(global)) return [...a];
  return a.filter((item) => b.includes(item));
}

const uniqSorted = (items: string[]) => [...new Set(items)].sort();

/* ------------------------------------------------------------------ */
/* 冲突检测引擎：输出带稳定指纹与精确重叠维度的冲突                       */
/* ------------------------------------------------------------------ */

function fingerprintFor(
  ids: [string, string],
  versions: [number, number],
  dim: { tags: string[]; territories: string[]; platforms: string[]; window: DateWindow },
) {
  // 指纹带资产版本：换版后指纹立即不同，旧例外只能 stale 后重新申请
  const pair = ids.map((id, idx) => `${id}@v${versions[idx]}`).sort().join('|');
  const tags = uniqSorted(dim.tags).join('|');
  const territories = uniqSorted(dim.territories).join('|');
  const platforms = uniqSorted(dim.platforms).join('|');
  return `FP:${pair}|T:${tags}|R:${territories}|P:${platforms}|D:${dim.window.from}..${dim.window.to}`;
}

export function buildConflicts(allAssets: Asset[], projectId: string): RightsConflict[] {
  const list = allAssets.filter((asset) => asset.projectId === projectId);
  const out: RightsConflict[] = [];
  for (let i = 0; i < list.length; i += 1) {
    for (let j = i + 1; j < list.length; j += 1) {
      const a = list[i];
      const b = list[j];
      const tags = a.rightsTags.filter((tag) => b.rightsTags.includes(tag));
      const territories = intersectList(a.territories, b.territories, GLOBAL_TERRITORY);
      const platforms = a.platforms.filter((p) => b.platforms.includes(p));
      const window = intersectWindow({ from: a.availableFrom, to: a.availableTo }, { from: b.availableFrom, to: b.availableTo });
      if (!tags.length || !territories.length || !platforms.length || !window) continue;
      const sharedTags = uniqSorted(tags);
      out.push({
        fingerprint: fingerprintFor([a.id, b.id], [a.version, b.version], { tags, territories, platforms, window }),
        projectId,
        severity: a.status === 'locked' || b.status === 'locked' ? 'critical' : 'warning',
        pair: [a.id, b.id],
        names: [a.name, b.name],
        versions: [a.version, b.version],
        reasons: sharedTags.map((tag) => `同一授权标签「${tag}」在重叠窗口内覆盖相同地域/平台`),
        tags: sharedTags,
        territories: uniqSorted(territories),
        platforms: uniqSorted(platforms),
        window,
      });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 异常存储：仅追加事件日志，重启时回放恢复                               */
/* ------------------------------------------------------------------ */

export type ExceptionEvent =
  | { kind: 'requested'; at: string; exception: RightsException }
  | { kind: 'decided'; at: string; id: string; decision: 'approved' | 'rejected'; actor: string; comment: string; revision: number }
  | { kind: 'revoked'; at: string; id: string; actor: string; reason: string; revision: number }
  | { kind: 'lapsed'; at: string; id: string; to: 'expired' | 'stale' | 'timedout'; reason: string };

export interface ExceptionEventStore {
  all(): RightsException[];
  apply(event: ExceptionEvent): void;
}

export class InMemoryExceptionStore implements ExceptionEventStore {
  protected items = new Map<string, RightsException>();
  all() { return [...this.items.values()]; }
  apply(event: ExceptionEvent) { applyEvent(this.items, event); }
}

export class FileExceptionStore extends InMemoryExceptionStore {
  readonly fresh: boolean;
  private constructor(private readonly path: string, existed: boolean) {
    super();
    this.fresh = !existed;
  }

  static open(path: string): FileExceptionStore {
    let existed = true;
    let raw = '';
    try {
      raw = readFileSync(path, 'utf8');
    } catch {
      existed = false;
    }
    const store = new FileExceptionStore(path, existed);
    raw.split('\n').filter((line) => line.trim()).forEach((line, index) => {
      try {
        store.apply(JSON.parse(line) as ExceptionEvent);
      } catch (cause) {
        throw new Error(`例外事件日志第 ${index + 1} 行损坏，拒绝启动: ${(cause as Error).message}`);
      }
    });
    return store;
  }

  override apply(event: ExceptionEvent) {
    super.apply(event);
    appendFileSync(this.path, `${JSON.stringify(event)}\n`);
  }
}

function applyEvent(items: Map<string, RightsException>, event: ExceptionEvent) {
  switch (event.kind) {
    case 'requested':
      items.set(event.exception.id, structuredClone(event.exception));
      break;
    case 'decided': {
      const item = items.get(event.id);
      if (!item) throw new Error(`未知例外 ${event.id}`);
      item.status = event.decision;
      item.decidedAt = event.at;
      item.decisionComment = event.comment;
      item.revision = event.revision;
      item.history.push({ at: event.at, action: event.decision, actor: event.actor, reason: event.comment || (event.decision === 'approved' ? '指定审批人批准例外' : '指定审批人驳回例外') });
      break;
    }
    case 'revoked': {
      const item = items.get(event.id);
      if (!item) throw new Error(`未知例外 ${event.id}`);
      item.status = 'revoked';
      item.revision = event.revision;
      item.history.push({ at: event.at, action: 'revoked', actor: event.actor, reason: event.reason });
      break;
    }
    case 'lapsed': {
      const item = items.get(event.id);
      if (!item) throw new Error(`未知例外 ${event.id}`);
      item.status = event.to;
      item.history.push({ at: event.at, action: event.to, actor: 'system', reason: event.reason });
      break;
    }
  }
}

/* ------------------------------------------------------------------ */
/* 并发互斥：申请 / 审批 / 撤销 / 换版 / 交付预检共用同一把串行锁          */
/* ------------------------------------------------------------------ */

export class Mutex {
  private chain: Promise<unknown> = Promise.resolve();
  withLock<T>(fn: () => T | Promise<T>): Promise<T> {
    const run = this.chain.then(() => fn());
    this.chain = run.then(() => undefined, () => undefined);
    return run;
  }
}

export class RightsError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

export interface Clock { now(): string; today(): string; }

export const systemClock: Clock = {
  now: () => new Date().toISOString(),
  today: () => dateKey(new Date()),
};

export interface RequestExceptionInput {
  projectId: string;
  conflictFingerprint: string;
  scope: ExceptionScope;
  justification: string;
  requestedBy: string;
  approver: string;
}

/* ------------------------------------------------------------------ */
/* 核心领域服务                                                          */
/* ------------------------------------------------------------------ */

export interface RightsServiceDeps {
  assets: Asset[];
  clock?: Clock;
  slaHours?: number;
  maxWindowDays?: number;
}

/** 测试 / 独立装配：内存事件存储 + 可控时钟 + 深拷贝资产（换版测试互不污染） */
export function createRightsService(deps: RightsServiceDeps): { service: RightsService; store: InMemoryExceptionStore; assets: Asset[] } {
  const clonedAssets: Asset[] = deps.assets.map((asset) => structuredClone(asset));
  const store = new InMemoryExceptionStore();
  const service = new RightsService(store, { ...deps, assets: clonedAssets });
  return { service, store, assets: clonedAssets };
}

/** 可控时钟：days 表示相对固定基准日 2026-09-15 的日期偏移，hour 为当天小时 */
export function fakeClock(days = 0, hour = 12): Clock & { advanceDays: (d: number) => void; advanceHours: (h: number) => void } {
  let current = new Date(Date.UTC(2026, 8, 15 + days, hour, 0, 0));
  return {
    now: () => current.toISOString(),
    today: () => dateKey(current),
    advanceDays: (d: number) => { current = new Date(current.getTime() + d * DAY_MS); },
    advanceHours: (h: number) => { current = new Date(current.getTime() + h * 3_600_000); },
  };
}

export class RightsService {
  private readonly clock: Clock;
  private readonly slaHours: number;
  private readonly maxWindowDays: number;
  private readonly mutex = new Mutex();
  private seq = 200;

  constructor(
    private readonly store: ExceptionEventStore,
    private readonly deps: RightsServiceDeps,
  ) {
    this.clock = deps.clock ?? systemClock;
    this.slaHours = deps.slaHours ?? DEFAULT_SLA_HOURS;
    this.maxWindowDays = deps.maxWindowDays ?? MAX_WINDOW_DAYS;
  }

  /* 启动 / 定时：恢复后扫一遍，过期与超时落库，风险立即恢复（写操作加锁） */
  sweep(): Promise<void> {
    return this.mutex.withLock(() => this.runSweep());
  }

  private runSweep(): void {
    const today = this.clock.today();
    const nowMs = Date.parse(this.clock.now());
    const conflictsByProject = new Map<string, RightsConflict[]>();
    const projects = new Set(this.store.all().map((item) => item.projectId));
    for (const projectId of projects) {
      conflictsByProject.set(projectId, buildConflicts(this.deps.assets, projectId));
    }
    for (const item of this.store.all()) {
      const conflict = conflictsByProject.get(item.projectId)?.find((c) => c.fingerprint === item.conflictFingerprint);
      if ((item.status === 'pending' || item.status === 'approved') && !conflict) {
        this.lapse(item, 'stale', '冲突指纹已不存在（资产或授权窗口变更），未决例外自动失效，须重新发起申请');
        continue;
      }
      if (!conflict) continue;
      if (item.status === 'pending' && Date.parse(item.slaDueAt) < nowMs) {
        this.lapse(item, 'timedout', `超过审批时限 ${item.slaDueAt}，指定审批人未处理，申请自动失效，冲突风险恢复`);
        continue;
      }
      if (item.status === 'approved') {
        if (!this.versionsCurrent(item, conflict)) {
          this.lapse(item, 'stale', `资产换版（v${item.assetVersions[0]}→v${conflict.versions[0]} / v${item.assetVersions[1]}→v${conflict.versions[1]}）后批准例外失效，须按新版本重新申请，冲突风险恢复`);
          continue;
        }
        const effective = intersectWindow(item.scope.dates, conflict.window);
        if (!effective || effective.to < today) {
          this.lapse(item, 'expired', `例外窗口 ${item.scope.dates.from}..${item.scope.dates.to} 已到期，抑制解除，冲突风险恢复`);
        }
      }
    }
  }

  listConflicts(projectId: string): ConflictView[] {
    return buildConflicts(this.deps.assets, projectId).map((conflict) => this.view(conflict));
  }

  listExceptions(projectId: string): ExceptionView[] {
    return this.store.all()
      .filter((item) => item.projectId === projectId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((item) => this.describe(item, this.findConflict(item)));
  }

  /** 按冲突资产对聚合例外（换版后旧指纹消失，也能从新冲突追溯旧版本上的 stale 例外） */
  exceptionsForPair(projectId: string, pair: [string, string]): ExceptionView[] {
    return this.store.all()
      .filter((item) => item.projectId === projectId
        && item.assetIds.length === 2
        && [...item.assetIds].sort().join('|') === [...pair].sort().join('|'))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((item) => this.describe(item, this.findConflict(item)));
  }

  /** 法务发起有期限例外申请；重复申请幂等返回原单（串行化，避免重复落库） */
  requestException(input: RequestExceptionInput): Promise<{ exception: ExceptionView; deduplicated: boolean }> {
    return this.mutex.withLock(() => this.request(input));
  }

  private request(input: RequestExceptionInput): { exception: ExceptionView; deduplicated: boolean } {
    const conflict = buildConflicts(this.deps.assets, input.projectId)
      .find((c) => c.fingerprint === input.conflictFingerprint);
    if (!conflict) throw new RightsError(404, 'conflict_not_found', '冲突不存在或指纹已失效，请刷新冲突列表后重新申请');

    const scope = this.normalizeAndValidateScope(input.scope, conflict);
    if (!input.justification.trim()) throw new RightsError(400, 'justification_required', '必须填写业务理由（发行项目 / 平台 / 短日期依据）');
    if (!input.requestedBy.trim() || !input.approver.trim()) throw new RightsError(400, 'approver_required', '必须指定法务发起人与审批人');

    const duplicate = this.store.all().find((item) =>
      item.projectId === input.projectId
      && item.conflictFingerprint === input.conflictFingerprint
      && (item.status === 'pending' || item.status === 'approved')
      && canonicalScope(item.scope) === canonicalScope(scope));
    if (duplicate) {
      return { exception: this.describe(duplicate, conflict), deduplicated: true };
    }

    const now = this.clock.now();
    const exception: RightsException = {
      id: `EXC-${++this.seq}`,
      projectId: input.projectId,
      conflictFingerprint: conflict.fingerprint,
      assetIds: conflict.pair,
      assetVersions: conflict.versions,
      scope,
      justification: input.justification.trim(),
      requestedBy: input.requestedBy.trim(),
      approver: input.approver.trim(),
      status: 'pending',
      createdAt: now,
      slaDueAt: new Date(Date.parse(now) + this.slaHours * 3_600_000).toISOString(),
      revision: 0,
      history: [{
        at: now,
        action: 'created',
        actor: input.requestedBy.trim(),
        reason: `法务就 ${conflict.names[0]} ↔ ${conflict.names[1]} 发起 ${scope.dates.from}..${scope.dates.to} 的范围例外，等待 ${input.approver} 审批`,
      }],
    };
    this.store.apply({ kind: 'requested', at: now, exception });
    return { exception: this.describe(exception, conflict), deduplicated: false };
  }

  decide(id: string, decision: 'approved' | 'rejected', actor: string, comment: string | undefined, expectedRevision?: number): Promise<ExceptionView> {
    return this.mutex.withLock(() => this.runDecide(id, decision, actor, comment, expectedRevision));
  }

  private runDecide(id: string, decision: 'approved' | 'rejected', actor: string, comment: string | undefined, expectedRevision?: number): ExceptionView {
    const item = this.mustFind(id);
    if (item.status !== 'pending') {
      throw new RightsError(409, 'invalid_state', `例外 ${id} 当前状态为 ${item.status}，不能再审批（可能已被撤销或超时）`);
    }
    if (expectedRevision !== undefined && expectedRevision !== item.revision) {
      throw new RightsError(409, 'revision_conflict', `例外 ${id} 已被他人更新（revision ${item.revision}），请刷新后重试`);
    }
    const at = this.clock.now();
    this.store.apply({
      kind: 'decided',
      at,
      id,
      decision,
      actor: actor || item.approver,
      comment: comment?.trim() || (decision === 'approved' ? '同意按申请范围抑制匹配冲突' : '驳回例外申请'),
      revision: item.revision + 1,
    });
    return this.describe(this.mustFind(id), this.findConflict(this.mustFind(id)));
  }

  revoke(id: string, actor: string, reason: string): Promise<ExceptionView> {
    return this.mutex.withLock(() => this.runRevoke(id, actor, reason));
  }

  private runRevoke(id: string, actor: string, reason: string): ExceptionView {
    const item = this.mustFind(id);
    if (item.status !== 'approved') {
      throw new RightsError(409, 'invalid_state', `只有已批准例外可撤销，${id} 当前为 ${item.status}`);
    }
    if (!reason.trim()) throw new RightsError(400, 'reason_required', '撤销必须填写理由（如版权方撤回许可），并随审计留痕');
    const at = this.clock.now();
    this.store.apply({ kind: 'revoked', at, id, actor, reason: reason.trim(), revision: item.revision + 1 });
    return this.describe(this.mustFind(id), this.findConflict(this.mustFind(id)));
  }

  /** 资产换版：旧版本上的未决 / 已批准例外一律 stale，不随版本延续 */
  onAssetVersioned(assetId: string, oldVersion: number, newVersion: number): Promise<void> {
    return this.mutex.withLock(() => {
      for (const item of this.store.all()) {
        const idx = item.assetIds.indexOf(assetId);
        if (idx < 0) continue;
        if (item.status !== 'pending' && item.status !== 'approved') continue;
        if (item.assetVersions[idx] !== oldVersion) continue;
        this.lapse(item, 'stale', `资产 ${assetId} 从 v${oldVersion} 换版为 v${newVersion}，${item.status === 'pending' ? '未决申请' : '已批准例外'}不随版本延续，须重新发起`);
      }
    });
  }

  /* 交付预检：在锁内取快照，区分真实无冲突 / 例外放行 / 真实风险阻断；
     与撤销 / 决定 / 换版共用同一把锁，防止放行后立即撤销的竞态 */
  preflight(projectId: string, target: {
    territories?: string[];
    platforms?: string[];
    dates: DateWindow;
    assetIds?: string[];
  }): Promise<PreflightReport> {
    return this.mutex.withLock(() => this.runPreflight(projectId, target));
  }

  private runPreflight(projectId: string, target: {
    territories?: string[];
    platforms?: string[];
    dates: DateWindow;
    assetIds?: string[];
  }): PreflightReport {
    const wanted = {
      territories: target.territories?.length ? target.territories : [GLOBAL_TERRITORY],
      platforms: target.platforms?.length ? target.platforms : [ALL_PLATFORMS],
      window: target.dates,
    };
    const reports: PreflightConflict[] = [];
    for (const conflict of buildConflicts(this.deps.assets, projectId)) {
      if (target.assetIds?.length && !target.assetIds.some((id) => conflict.pair.includes(id))) continue;
      const restricted = this.restrict(conflict, wanted.territories, wanted.platforms, wanted.window);
      if (!restricted) continue;
      // 预检以交付窗口起点为视界：窗口起点之前的历史残差不阻断交付
      const evaluation = this.evaluate(conflict.fingerprint, restricted, this.store.all(), wanted.window.from);
      reports.push({
        fingerprint: conflict.fingerprint,
        names: conflict.names,
        severity: conflict.severity,
        suppression: evaluation.suppression,
        residualSlices: evaluation.residualSlices,
        coveredSlices: evaluation.coveredSlices,
        historicalSlices: evaluation.historicalSlices,
        exceptions: evaluation.activeExceptionIds,
      });
    }
    const blocked = reports.filter((r) => r.suppression !== 'full');
    const usedExceptions = [...new Set(reports.flatMap((r) => r.exceptions))];
    const verdict = blocked.length ? 'blocked' : usedExceptions.length ? 'exception' : 'clean';
    return {
      projectId,
      target: wanted,
      verdict,
      at: this.clock.now(),
      conflictCount: reports.length,
      blockedCount: blocked.length,
      usedExceptions,
      conflicts: reports,
    };
  }

  /* ---------------------------------------------------------------- */

  private lapse(item: RightsException, to: 'expired' | 'stale' | 'timedout', reason: string) {
    this.store.apply({ kind: 'lapsed', at: this.clock.now(), id: item.id, to, reason });
  }

  private mustFind(id: string): RightsException {
    const item = this.store.all().find((candidate) => candidate.id === id);
    if (!item) throw new RightsError(404, 'exception_not_found', `例外 ${id} 不存在`);
    return item;
  }

  private findConflict(item: RightsException): RightsConflict | undefined {
    return buildConflicts(this.deps.assets, item.projectId).find((c) => c.fingerprint === item.conflictFingerprint);
  }

  private versionsCurrent(item: RightsException, conflict: RightsConflict) {
    return item.assetIds.every((id, idx) => {
      const pos = conflict.pair.indexOf(id);
      if (pos < 0) return false;
      return item.assetVersions[idx] === conflict.versions[pos];
    });
  }

  private normalizeAndValidateScope(scope: ExceptionScope, conflict: RightsConflict): ExceptionScope {
    const territories = uniqSorted(scope.territories ?? []);
    const platforms = uniqSorted(scope.platforms ?? []);
    const tags = uniqSorted(scope.tags ?? []);
    if (!territories.length) throw new RightsError(400, 'scope_invalid', '例外必须限定至少一个地域（或选择全球）');
    if (!platforms.length) throw new RightsError(400, 'scope_invalid', '例外必须限定至少一个平台（或选择全部平台）');
    if (!scope.dates?.from || !scope.dates?.to || scope.dates.from > scope.dates.to) {
      throw new RightsError(400, 'scope_invalid', '例外日期窗口无效');
    }
    if (!intersectList(territories, conflict.territories, GLOBAL_TERRITORY).length) {
      throw new RightsError(400, 'scope_outside_conflict', '申请地域与冲突重叠地域无交集');
    }
    if (!intersectList(platforms, conflict.platforms, ALL_PLATFORMS).length) {
      throw new RightsError(400, 'scope_outside_conflict', '申请平台与冲突重叠平台无交集');
    }
    if (tags.length && !tags.some((tag) => conflict.tags.includes(tag))) {
      throw new RightsError(400, 'scope_outside_conflict', '申请标签不属于该冲突的重叠标签');
    }
    const window = intersectWindow(scope.dates, conflict.window);
    if (!window) throw new RightsError(400, 'scope_outside_conflict', '申请日期与冲突重叠窗口无交集');
    if (scope.dates.from < this.clock.today()) {
      throw new RightsError(400, 'scope_invalid', '例外起始日不能早于今天（例外只面向未来短窗口）');
    }
    if (daysBetween(window.from, window.to) + 1 > this.maxWindowDays) {
      throw new RightsError(400, 'scope_too_long', `例外窗口最长 ${this.maxWindowDays} 天，请缩短日期或在到期前重新申请`);
    }
    return { territories, platforms, tags, dates: { from: scope.dates.from, to: scope.dates.to } };
  }

  private restrict(conflict: RightsConflict, territories: string[], platforms: string[], window: DateWindow): ConflictDimension | undefined {
    const t = intersectList(territories, conflict.territories, GLOBAL_TERRITORY);
    const p = intersectList(platforms, conflict.platforms, ALL_PLATFORMS);
    const w = intersectWindow(window, conflict.window);
    if (!t.length || !p.length || !w) return undefined;
    return { territories: t, platforms: p, window: w, tags: conflict.tags };
  }

  private view(conflict: RightsConflict): ConflictView {
    const evaluation = this.evaluate(conflict.fingerprint, conflict, this.store.all(), this.clock.today());
    // 同时带上同资产对、旧版本上的 stale/expired 例外，供版权页解释“为什么此前的放行不延续”
    const exceptions = this.exceptionsForPair(conflict.projectId, conflict.pair);
    return { ...conflict, ...evaluation, exceptions };
  }

  private describe(item: RightsException, conflict: RightsConflict | undefined): ExceptionView {
    const today = this.clock.today();
    const base: ExceptionView = { ...structuredClone(item), phase: 'pending' };
    const effective = conflict ? intersectWindow(item.scope.dates, conflict.window) : undefined;
    base.effective = effective;

    if (item.status === 'rejected') {
      base.phase = 'rejected';
      base.ineffectivenessReason = `申请已于 ${item.decidedAt} 被 ${item.approver} 驳回：${item.decisionComment || '无补充说明'}，冲突风险保持`;
      return base;
    }
    if (item.status === 'revoked') {
      const revoked = [...item.history].reverse().find((h) => h.action === 'revoked');
      base.phase = 'revoked';
      base.ineffectivenessReason = `已于 ${revoked?.at} 被 ${revoked?.actor} 撤销：${revoked?.reason}。抑制解除，冲突风险恢复`;
      return base;
    }
    if (item.status === 'expired' || item.status === 'stale' || item.status === 'timedout') {
      base.phase = item.status;
      const entry = [...item.history].reverse().find((h) => h.action === item.status);
      base.ineffectivenessReason = entry?.reason;
      return base;
    }
    if (item.status === 'pending') {
      if (Date.parse(item.slaDueAt) < Date.parse(this.clock.now())) {
        base.phase = 'timedout';
        base.ineffectivenessReason = `超过审批时限 ${item.slaDueAt}，等待系统扫表恢复风险`;
        return base;
      }
      base.phase = 'pending';
      base.ineffectivenessReason = `等待指定审批人 ${item.approver} 在 ${item.slaDueAt} 前处理；在此之前冲突仍为真实风险`;
      return base;
    }
    // approved
    if (conflict && !this.versionsCurrent(item, conflict)) {
      base.phase = 'stale';
      base.ineffectivenessReason = '资产已换版，该例外不随版本延续，须按新版本重新申请';
      return base;
    }
    if (!conflict) {
      base.phase = 'stale';
      base.ineffectivenessReason = '冲突指纹已不存在，例外自动失效';
      return base;
    }
    if (!effective || effective.to < today) {
      base.phase = 'expired';
      base.ineffectivenessReason = `例外窗口 ${item.scope.dates.from}..${item.scope.dates.to} 已到期，抑制解除，冲突风险恢复`;
      return base;
    }
    const where = `${item.scope.territories.includes(GLOBAL_TERRITORY) ? '全球' : item.scope.territories.join('/')} · ${item.scope.platforms.includes(ALL_PLATFORMS) ? '全平台' : item.scope.platforms.join('/')}`;
    const tagsLabel = item.scope.tags.length ? item.scope.tags.join('、') : '全部重叠标签';
    if (effective.from > today) {
      base.phase = 'scheduled';
      base.effectivenessReason = `已批准，将于 ${effective.from} 起在 ${where} 抑制「${tagsLabel}」，${effective.to} 到期`;
      return base;
    }
    base.phase = 'active';
    base.effectivenessReason = `已批准例外生效中：${effective.from}..${effective.to}，${where}，抑制「${tagsLabel}」；到期自动恢复风险`;
    return base;
  }

  private evaluate(fingerprint: string, conflict: ConflictDimension, all: RightsException[], horizonFrom: string): {
    suppression: 'open' | 'partial' | 'full';
    residualSlices: ScopeSlice[];
    coveredSlices: CoveredSlice[];
    historicalSlices: ScopeSlice[];
    activeExceptionIds: string[];
  } {
    const today = this.clock.today();
    const versionsOf = (id: string) => this.deps.assets.find((a) => a.id === id)?.version;

    const candidates = all
      .filter((item) => item.conflictFingerprint === fingerprint && item.status === 'approved')
      .flatMap((item) => {
        // 资产换版后不抑制：必须两个资产版本都仍是申请时版本
        const versionsOk = item.assetIds.every((id, idx) => versionsOf(id) === item.assetVersions[idx]);
        if (!versionsOk) return [];
        // 覆盖判定：申请侧通配（全球 / 全平台）时展开到冲突侧全集，不收窄
        const territories = item.scope.territories.includes(GLOBAL_TERRITORY)
          ? [...conflict.territories]
          : item.scope.territories.filter((t) => conflict.territories.includes(t));
        const platforms = item.scope.platforms.includes(ALL_PLATFORMS)
          ? [...conflict.platforms]
          : item.scope.platforms.filter((p) => conflict.platforms.includes(p));
        const tags = item.scope.tags.length ? item.scope.tags.filter((t) => conflict.tags.includes(t)) : [...conflict.tags];
        const window = intersectWindow(item.scope.dates, conflict.window);
        if (!territories.length || !platforms.length || !tags.length || !window || window.to < today) return [];
        return [{ id: item.id, territories, platforms, tags, from: window.from, to: window.to }];
      });

    // 用各候选窗口边界把时间轴切成覆盖关系恒定的小段
    const boundaries = uniqSorted([
      conflict.window.from,
      addDays(conflict.window.to, 1),
      ...candidates.flatMap((c) => [c.from, addDays(c.to, 1)]),
    ]).filter((d) => d >= conflict.window.from && d <= addDays(conflict.window.to, 1));

    interface Cell { tags: Set<string>; territories: Set<string>; platforms: Set<string>; covered: boolean; ids: string[]; }
    const segments: { from: string; to: string; cells: Cell[] }[] = [];
    for (let i = 0; i + 1 < boundaries.length; i += 1) {
      const from = boundaries[i];
      const to = addDays(boundaries[i + 1], -1);
      const cells: Cell[] = [];
      for (const tag of conflict.tags) {
        for (const territory of conflict.territories) {
          for (const platform of conflict.platforms) {
            const covers = candidates.filter((c) =>
              c.tags.includes(tag) && c.territories.includes(territory) && c.platforms.includes(platform)
              && from >= c.from && to <= c.to);
            cells.push({
              tags: new Set([tag]),
              territories: new Set([territory]),
              platforms: new Set([platform]),
              covered: covers.length > 0,
              ids: covers.map((c) => c.id),
            });
          }
        }
      }
      segments.push({ from, to, cells });
    }

    const keyOf = (covered: boolean, ids: string[]) => `${covered ? '1' : '0'}:${[...ids].sort().join('|')}`;
    const rawResidual: ScopeSlice[] = [];
    const coveredSlices: CoveredSlice[] = [];

    for (const segment of segments) {
      const groups = new Map<string, Cell>();
      for (const cell of segment.cells) {
        const key = keyOf(cell.covered, cell.ids);
        const existing = groups.get(key);
        if (existing) {
          existing.tags.add([...cell.tags][0]);
          existing.territories.add([...cell.territories][0]);
          existing.platforms.add([...cell.platforms][0]);
        } else {
          groups.set(key, {
            tags: new Set(cell.tags),
            territories: new Set(cell.territories),
            platforms: new Set(cell.platforms),
            covered: cell.covered,
            ids: cell.ids,
          });
        }
      }
      for (const group of groups.values()) {
        const slice = {
          territories: [...group.territories].sort(),
          platforms: [...group.platforms].sort(),
          tags: [...group.tags].sort(),
          from: segment.from,
          to: segment.to,
        };
        if (group.covered) {
          const last = coveredSlices[coveredSlices.length - 1];
          const ids = [...group.ids].sort();
          if (last && last.to === addDays(segment.from, -1)
            && sameDims(last, slice) && canonicalList(last.exceptionIds) === canonicalList(ids)) {
            last.to = segment.to;
          } else {
            coveredSlices.push({ ...slice, exceptionIds: ids });
          }
        } else {
          const last = rawResidual[rawResidual.length - 1];
          if (last && sameDims(last, slice) && last.to === addDays(segment.from, -1)) {
            last.to = segment.to;
          } else {
            rawResidual.push({ ...slice });
          }
        }
      }
    }

    // 视界切分：视界起点之前的残差只是历史，不计入当前风险 / 交付阻断
    const residualSlices: ScopeSlice[] = [];
    const historicalSlices: ScopeSlice[] = [];
    for (const slice of rawResidual) {
      if (slice.to < horizonFrom) {
        historicalSlices.push(slice);
      } else if (slice.from < horizonFrom) {
        historicalSlices.push({ ...slice, to: addDays(horizonFrom, -1) });
        residualSlices.push({ ...slice, from: horizonFrom });
      } else {
        residualSlices.push(slice);
      }
    }

    const suppression = residualSlices.length > 0
      ? (coveredSlices.length > 0 ? 'partial' : 'open')
      : 'full';
    return {
      suppression,
      residualSlices,
      coveredSlices,
      historicalSlices,
      activeExceptionIds: [...new Set(candidates.map((c) => c.id))].sort(),
    };
  }
}

function sameDims(a: ScopeSlice, b: ScopeSlice) {
  return canonicalList(a.tags) === canonicalList(b.tags)
    && canonicalList(a.territories) === canonicalList(b.territories)
    && canonicalList(a.platforms) === canonicalList(b.platforms);
}
const canonicalList = (items: string[]) => [...items].sort().join('|');
function canonicalScope(scope: ExceptionScope) {
  return JSON.stringify({
    r: uniqSorted(scope.territories),
    p: uniqSorted(scope.platforms),
    t: uniqSorted(scope.tags),
    d: [scope.dates.from, scope.dates.to],
  });
}

/* ------------------------------------------------------------------ */
/* 交付预检报告                                                          */
/* ------------------------------------------------------------------ */

export interface PreflightConflict {
  fingerprint: string;
  names: [string, string];
  severity: 'critical' | 'warning';
  suppression: 'open' | 'partial' | 'full';
  residualSlices: ScopeSlice[];
  coveredSlices: CoveredSlice[];
  historicalSlices: ScopeSlice[];
  exceptions: string[];
}

export interface PreflightReport {
  projectId: string;
  target: { territories: string[]; platforms: string[]; window: DateWindow };
  /** clean：真实无冲突；exception：全部依赖已批准例外；blocked：残差真实风险 */
  verdict: 'clean' | 'exception' | 'blocked';
  at: string;
  conflictCount: number;
  blockedCount: number;
  usedExceptions: string[];
  conflicts: PreflightConflict[];
}

/* ------------------------------------------------------------------ */
/* 演示种子：仅在事件日志首次创建时写入，重启后靠回放恢复                  */
/* ------------------------------------------------------------------ */

export function seedDemoExceptions(store: ExceptionEventStore, assets: Asset[], clock: Clock = systemClock) {
  const today = clock.today();
  const find = (projectId: string, a: string, b: string) =>
    buildConflicts(assets, projectId).find((c) => c.pair.includes(a) && c.pair.includes(b));

  // EXC-101：PRJ-002 航拍素材冲突，已批准但只覆盖短窗口 → 部分抑制
  const c101 = find('PRJ-002', 'AST-004', 'AST-006');
  if (c101) {
    const requestedAt = new Date(Date.parse(`${today}T08:00:00Z`) - 5 * DAY_MS).toISOString();
    const exception: RightsException = {
      id: 'EXC-101', projectId: 'PRJ-002', conflictFingerprint: c101.fingerprint,
      assetIds: c101.pair, assetVersions: c101.versions,
      scope: { territories: [GLOBAL_TERRITORY], platforms: ['影院', 'StreamBox'], dates: { from: today, to: addDays(today, 78) }, tags: [] },
      justification: '节展首映周期内的全球院线/流媒体临时放行，版权方邮件确认限窗（79 天）',
      requestedBy: '法务-周敏', approver: '法务负责人', status: 'approved',
      createdAt: requestedAt, decidedAt: new Date(Date.parse(requestedAt) + DAY_MS).toISOString(),
      decisionComment: '仅限节展窗口，到期前必须取得正式许可或下线',
      slaDueAt: new Date(Date.parse(requestedAt) + DEFAULT_SLA_HOURS * 3_600_000).toISOString(),
      revision: 1,
      history: [
        { at: requestedAt, action: 'created', actor: '法务-周敏', reason: '就航拍素材重叠发起节展限窗例外' },
        { at: new Date(Date.parse(requestedAt) + DAY_MS).toISOString(), action: 'approved', actor: '法务负责人', reason: '仅限节展窗口，到期前必须取得正式许可或下线' },
      ],
    };
    store.apply({ kind: 'requested', at: requestedAt, exception });
    store.apply({ kind: 'decided', at: exception.decidedAt!, id: exception.id, decision: 'approved', actor: '法务负责人', comment: exception.decisionComment!, revision: 1 });
  }

  // EXC-102：PRJ-001 母版×音乐特辑，待审批
  const c102 = find('PRJ-001', 'AST-001', 'AST-005');
  if (c102) {
    const now = clock.now();
    const exception: RightsException = {
      id: 'EXC-102', projectId: 'PRJ-001', conflictFingerprint: c102.fingerprint,
      assetIds: c102.pair, assetVersions: c102.versions,
      scope: { territories: ['CN'], platforms: ['StreamBox'], dates: { from: today, to: addDays(today, 40) }, tags: [] },
      justification: '上线首月同步许可谈判收尾，申请 40 天 CN/StreamBox 限窗',
      requestedBy: '法务-周敏', approver: '法务负责人', status: 'pending',
      createdAt: now, slaDueAt: new Date(Date.parse(now) + DEFAULT_SLA_HOURS * 3_600_000).toISOString(),
      revision: 0,
      history: [{ at: now, action: 'created', actor: '法务-周敏', reason: '母版与音乐特辑同步许可重叠，等待法务负责人 48 小时内审批' }],
    };
    store.apply({ kind: 'requested', at: now, exception });
  }

  // EXC-103：片尾曲×音乐特辑，批准后被撤销 → 风险恢复
  const c103 = find('PRJ-001', 'AST-003', 'AST-005');
  if (c103) {
    const created = new Date(Date.parse(`${today}T08:00:00Z`) - 22 * DAY_MS).toISOString();
    const decided = new Date(Date.parse(created) + DAY_MS).toISOString();
    const revokedAt = new Date(Date.parse(`${today}T08:00:00Z`) - 3 * DAY_MS).toISOString();
    const exception: RightsException = {
      id: 'EXC-103', projectId: 'PRJ-001', conflictFingerprint: c103.fingerprint,
      assetIds: c103.pair, assetVersions: c103.versions,
      scope: { territories: ['CN'], platforms: ['StreamBox'], dates: { from: addDays(today, -3), to: addDays(today, 40) }, tags: [] },
      justification: '片尾曲 MV 宣发限窗',
      requestedBy: '法务-周敏', approver: '法务负责人', status: 'revoked',
      createdAt: created, decidedAt: decided, decisionComment: '同意宣发限窗',
      slaDueAt: new Date(Date.parse(created) + DEFAULT_SLA_HOURS * 3_600_000).toISOString(),
      revision: 2,
      history: [
        { at: created, action: 'created', actor: '法务-周敏', reason: '片尾曲与音乐特辑重叠，发起宣发限窗例外' },
        { at: decided, action: 'approved', actor: '法务负责人', reason: '同意宣发限窗' },
        { at: revokedAt, action: 'revoked', actor: '法务负责人', reason: '版权方正式回函拒绝延展，撤销例外并恢复全部风险标记' },
      ],
    };
    store.apply({ kind: 'requested', at: created, exception });
    store.apply({ kind: 'decided', at: decided, id: exception.id, decision: 'approved', actor: '法务负责人', comment: '同意宣发限窗', revision: 1 });
    store.apply({ kind: 'revoked', at: revokedAt, id: exception.id, actor: '法务负责人', reason: '版权方正式回函拒绝延展，撤销例外并恢复全部风险标记', revision: 2 });
  }

  // EXC-104：母版×片尾曲，超过 SLA 未审批 → 启动扫表即超时失效
  const c104 = find('PRJ-001', 'AST-001', 'AST-003');
  if (c104) {
    const created = new Date(Date.parse(`${today}T08:00:00Z`) - 6 * DAY_MS).toISOString();
    const exception: RightsException = {
      id: 'EXC-104', projectId: 'PRJ-001', conflictFingerprint: c104.fingerprint,
      assetIds: c104.pair, assetVersions: c104.versions,
      scope: { territories: ['CN'], platforms: ['影院'], dates: { from: today, to: addDays(today, 20) }, tags: [] },
      justification: '点映场地域限窗申请，审批人出差未处理',
      requestedBy: '法务-林澈', approver: '法务负责人', status: 'pending',
      createdAt: created, slaDueAt: new Date(Date.parse(created) + DEFAULT_SLA_HOURS * 3_600_000).toISOString(),
      revision: 0,
      history: [{ at: created, action: 'created', actor: '法务-林澈', reason: '点映场院线限窗，等待法务负责人 48 小时内审批' }],
    };
    store.apply({ kind: 'requested', at: created, exception });
  }
}

/* 审计桥：例外生命周期同步写入平台审计事件 */
export function recordRightsAudit(action: string, entityId: string, actor: string, details: string) {
  auditEvents.unshift({ id: `AUD-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, action, entity: 'rights-exception', entityId, actor, at: new Date().toISOString(), details });
}
