/**
 * 版权冲突「有期限、可撤销例外」领域
 *
 * 设计要点：
 * - 冲突按 (版权标签 × 地域 × 平台 × 时间窗) 计算为原子格子；例外只抑制其作用域
 *   (项目 / 资产版本 / 地域 / 平台 / 起止日期) 覆盖到的格子，而非整笔冲突。
 * - 例外状态机 pending -> approved/rejected/timeout -> (active|expired|revoked|superseded)。
 *   approved 在 validFrom/validTo 与版本匹配时才实际生效；过期、撤销、资产换版都会恢复风险。
 * - 每次读取都惰性 sweep（到期、审批超时、换版漂移），并记录生效/失效理由事件。
 * - 交付预检与生成走同一评估器；生成采用 OCC 版本号，异步窗口内撤销/换版会级联失败，
 *   重新校验通过后才提交 manifest。状态落盘以支持重启恢复。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { assets as seedAssets, projects, auditEvents, dashboard as baseDashboard, type Asset } from './domain.js';

// ---------- 类型 ----------
export type ExceptionStatus =
  | 'pending' // 等待指定审批人
  | 'approved' // 已批准，按窗口生效/失效
  | 'rejected' // 已拒绝（终态）
  | 'timeout' // 审批超时（终态）
  | 'revoked'; // 生效后被撤销（终态）

export interface ExceptionEvent {
  at: string;
  action: 'created' | 'decided' | 'effective' | 'ineffective' | 'revoked';
  actor: string;
  reason: string;
}

export interface RightsException {
  id: string;
  projectId: string;
  conflictFingerprint?: string;
  assetId: string;
  assetVersion: number;
  territories: string[]; // 具体地域，['*'] = 全球
  platforms: string[]; // 具体平台，['*'] = 全部平台
  validFrom: string; // ISO date，含当日
  validTo: string; // ISO date，含当日
  reason: string; // 法务申请理由
  requestedBy: string;
  approver: string; // 指定审批人
  status: ExceptionStatus;
  decisionComment?: string;
  revokeReason?: string;
  createdAt: string;
  decidedAt?: string;
  revokedAt?: string;
  dedupeKey: string;
  history: ExceptionEvent[];
}

export interface ConflictCell {
  tag: string;
  territory: string;
  platform: string;
  windowFrom: string;
  windowTo: string;
}

export type ConflictStatus = 'open' | 'partial' | 'covered';
export type Severity = 'critical' | 'warning';

export interface EvaluatedConflict {
  fingerprint: string;
  assetAId: string;
  assetBId: string;
  assetAVersion: number;
  assetBVersion: number;
  assetA: string;
  assetB: string;
  severity: Severity;
  reason: string;
  active: boolean; // 时间窗在评估时点仍未结束
  cells: ConflictCell[];
  openCells: ConflictCell[]; // 未被任何生效例外覆盖的格子
  coveredCells: ConflictCell[];
  status: ConflictStatus; // open=真实风险 partial=部分例外 covered=全部已批准例外
  coveringExceptionIds: string[];
}

export interface DeliveryScope {
  territories: string[];
  platforms: string[];
  dateFrom: string;
  dateTo: string;
}

export type DeliveryVerdict = 'clear' | 'exceptions' | 'blocked';
export type DeliveryStatus = 'generating' | 'ready' | 'failed';

export interface DeliveryManifest {
  id: string;
  projectId: string;
  scope: DeliveryScope;
  requestedBy: string;
  status: DeliveryStatus;
  verdict: DeliveryVerdict;
  clientToken?: string;
  stateVersion: number;
  checkedConflicts: CheckedConflict[];
  failureReason?: string;
  createdAt: string;
  readyAt?: string;
  expiresAt: string; // manifest 本身的有效使用期限
}

interface PersistedState {
  exceptions: RightsException[];
  assetVersionOverrides: Record<string, number>;
  deliveries: DeliveryManifest[];
  stateVersion: number;
}

export class RightsError extends Error {
  constructor(public code: 400 | 403 | 404 | 409, message: string) {
    super(message);
  }
}

// ---------- 时间与常量 ----------
let generateDelayMs = Number(process.env.DELIVERY_GENERATE_MS ?? 1200);
export function setGenerateDelay(ms: number) {
  generateDelayMs = ms;
}
export const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

let clock: () => number = () => Date.now();
export function setClock(fn: () => number) {
  clock = fn;
}
export function nowIso(): string {
  return new Date(clock()).toISOString();
}
export function todayIso(): string {
  return nowIso().slice(0, 10);
}
const MS_PER_DAY = 86_400_000;
export const APPROVAL_SLA_MS = 2 * 24 * MS_PER_DAY; // 48 小时未决定 -> timeout
export const MAX_EXCEPTION_DAYS = 90;
const STATE_FILE =
  process.env.RIGHTS_STATE_FILE ?? new URL('../data/rights-state.json', import.meta.url).pathname;

export const GLOBAL = '*';
export const ALL_PLATFORMS = '*';

// ---------- 持久化存储（默认落盘，测试/无写权限时回退内存）----------
export interface RightsStore {
  exceptions: RightsException[];
  deliveries: DeliveryManifest[];
  stateVersion: number;
  assetVersion: (id: string) => number | undefined;
  bumpAssetVersion: (id: string, version: number) => void;
  persist: () => void;
}

function emptyState(): PersistedState {
  return { exceptions: [], assetVersionOverrides: {}, deliveries: [], stateVersion: 0 };
}

function loadState(): PersistedState {
  try {
    if (existsSync(STATE_FILE)) {
      return { ...emptyState(), ...(JSON.parse(readFileSync(STATE_FILE, 'utf8')) as PersistedState) };
    }
  } catch {
    // 无文件系统或解析失败 -> 种子数据
  }
  return emptyState();
}

let persisted = loadState();

export function createMemoryStore(seed: RightsException[]): RightsStore {
  const state: PersistedState = { exceptions: seed, assetVersionOverrides: {}, deliveries: [], stateVersion: 0 };
  return {
    exceptions: state.exceptions,
    deliveries: state.deliveries,
    get stateVersion() {
      return state.stateVersion;
    },
    set stateVersion(v: number) {
      state.stateVersion = v;
    },
    assetVersion: id => state.assetVersionOverrides[id],
    bumpAssetVersion: (id, v) => {
      state.assetVersionOverrides[id] = v;
    },
    persist() {},
  };
}

function diskStore(): RightsStore {
  return {
    exceptions: persisted.exceptions,
    deliveries: persisted.deliveries,
    get stateVersion() {
      return persisted.stateVersion;
    },
    set stateVersion(v: number) {
      persisted.stateVersion = v;
    },
    assetVersion: id => persisted.assetVersionOverrides[id],
    bumpAssetVersion: (id, v) => {
      persisted.assetVersionOverrides[id] = v;
    },
    persist() {
      try {
        mkdirSync(dirname(STATE_FILE), { recursive: true });
        writeFileSync(STATE_FILE, JSON.stringify(persisted, null, 2));
      } catch {
        // 只读环境下降级为纯内存
      }
    },
  };
}

let store: RightsStore = diskStore();

/** 测试隔离：重置为内存库 + 指定种子（或留空）；深拷贝保证各用例互不污染 */
export function resetForTests(seedExceptions: RightsException[] | null = null) {
  clearPendingTimers();
  const seed = seedExceptions ?? seedExceptionsForDemo();
  store = createMemoryStore(structuredClone(seed));
  return store;
}
/** 测试：直接替换底层存储（用于模拟重启恢复） */
export function setStoreForTests(next: RightsStore) {
  clearPendingTimers();
  store = next;
}
export function getStore() {
  return store;
}

// ---------- 工具 ----------
function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(to) - Date.parse(from)) / MS_PER_DAY);
}
function hash(input: string): string {
  let h = 5381;
  for (let i = 0; i < input.length; i += 1) h = ((h << 5) + h + input.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}
/** hash 已是字符串，安全截取短码 */
const shortHash = (input: string) => hash(input).slice(0, 4);
function record(action: string, entity: string, entityId: string, actor: string, details: string) {
  auditEvents.unshift({ id: `AUD-${Date.now()}-${shortHash(entityId + details)}`, action, entity, entityId, actor, at: nowIso(), details });
}
function bumpVersion() {
  store.stateVersion += 1;
  store.persist();
}

// ---------- 资产（含换版覆盖）----------
export function liveAssets(projectId: string): Asset[] {
  return seedAssets
    .filter(a => a.projectId === projectId)
    .map(a => ({ ...a, version: store.assetVersion(a.id) ?? a.version }));
}
function liveAsset(id: string): Asset | undefined {
  const base = seedAssets.find(a => a.id === id);
  return base ? { ...base, version: store.assetVersion(id) ?? base.version } : undefined;
}

/** 资产换版：例外不自动迁移到新版本，绑定旧版本的已批准例外立即漂移失效 */
export function bumpAssetVersion(assetId: string, actor: string, note = ''): Asset {
  const asset = seedAssets.find(a => a.id === assetId);
  if (!asset) throw new RightsError(404, '资产不存在');
  const next = (store.assetVersion(assetId) ?? asset.version) + 1;
  store.bumpAssetVersion(assetId, next);
  record('BUMP', 'asset', assetId, actor, `资产换版 v${asset.version} → v${next}${note ? `：${note}` : ''}`);
  // 立即处理版本漂移
  for (const ex of store.exceptions) {
    if (ex.assetId === assetId && (ex.status === 'approved' || ex.status === 'pending')) {
      const previous = ex.status;
      ex.status = 'revoked';
      ex.revokeReason = `资产已换版至 v${next}，例外仅授予 v${ex.assetVersion}，不予自动迁移`;
      ex.revokedAt = nowIso();
      ex.history.push({ at: nowIso(), action: 'ineffective', actor: 'system', reason: ex.revokeReason });
      if (previous === 'approved') record('EXCEPTION_DRIFT', 'rights-exception', ex.id, 'system', ex.revokeReason);
    }
  }
  bumpVersion();
  return liveAsset(assetId)!;
}

// ---------- 冲突引擎 ----------
export function conflictFingerprint(a: Asset, b: Asset, tag: string, from: string, to: string): string {
  const [x, y] = [a.id, b.id].sort();
  return `CFL-${hash([x, y, tag, from, to].join('|'))}`;
}

function expandTerritories(asset: Asset): string[] {
  // 「全球」在交集中等同通配，不生成具体地域
  return asset.territories.flatMap(t => (t === '全球' || t === GLOBAL ? [GLOBAL] : [t]));
}

/** 冲突格子 = 地域交集 × 平台交集 × 窗口交集；只在真实交叠处产生风险 */
function intersectCells(a: Asset, b: Asset, tag: string): ConflictCell[] {
  const ta = expandTerritories(a);
  const tb = expandTerritories(b);
  let territories: string[];
  if (ta.includes(GLOBAL)) territories = tb;
  else if (tb.includes(GLOBAL)) territories = ta;
  else territories = ta.filter(t => tb.includes(t));
  const pa = a.platforms.some(p => p === ALL_PLATFORMS) ? [ALL_PLATFORMS] : a.platforms;
  const pb = b.platforms.some(p => p === ALL_PLATFORMS) ? [ALL_PLATFORMS] : b.platforms;
  let platforms: string[];
  if (pa.includes(ALL_PLATFORMS)) platforms = pb;
  else if (pb.includes(ALL_PLATFORMS)) platforms = pa;
  else platforms = pa.filter(p => pb.includes(p));
  // 窗口交集（调用前已确认交叠）
  const from = a.availableFrom > b.availableFrom ? a.availableFrom : b.availableFrom;
  const to = a.availableTo < b.availableTo ? a.availableTo : b.availableTo;
  const cells: ConflictCell[] = [];
  for (const territory of territories)
    for (const platform of platforms) cells.push({ tag, territory, platform, windowFrom: from, windowTo: to });
  return cells;
}

/** 原始冲突（未考虑例外）：同一版权标签 × 地域交叠 × 平台交叠 × 窗口交叠 */
export function rawConflicts(projectId: string) {
  const list = liveAssets(projectId);
  const out: {
    fingerprint: string;
    assetA: Asset;
    assetB: Asset;
    severity: Severity;
    tag: string;
    reason: string;
    cells: ConflictCell[];
  }[] = [];
  for (let i = 0; i < list.length; i += 1)
    for (let j = i + 1; j < list.length; j += 1) {
      const a = list[i];
      const b = list[j];
      const sharedTags = a.rightsTags.filter(t => b.rightsTags.includes(t));
      const territoryHit =
        a.territories.some(t => t === '全球' || t === GLOBAL) ||
        b.territories.some(t => t === '全球' || t === GLOBAL) ||
        a.territories.some(t => b.territories.includes(t));
      const platformHit =
        a.platforms.some(p => p === ALL_PLATFORMS) ||
        b.platforms.some(p => p === ALL_PLATFORMS) ||
        a.platforms.some(p => b.platforms.includes(p));
      const windowHit = a.availableTo >= b.availableFrom && b.availableTo >= a.availableFrom;
      if (!sharedTags.length || !territoryHit || !platformHit || !windowHit) continue;
      for (const tag of sharedTags) {
        const cells = intersectCells(a, b, tag);
        out.push({
          fingerprint: conflictFingerprint(a, b, tag, cells[0].windowFrom, cells[0].windowTo),
          assetA: a,
          assetB: b,
          severity: a.status === 'locked' || b.status === 'locked' ? 'critical' : 'warning',
          tag,
          reason: `同一授权标签「${tag}」在重叠窗口内覆盖相同地域/平台`,
          cells,
        });
      }
    }
  return out;
}

// ---------- 例外生效判定（精确作用域）----------
function territoryCovered(cell: string, ex: RightsException): boolean {
  return ex.territories.includes(GLOBAL) || ex.territories.includes(cell);
}
function platformCovered(cell: string, ex: RightsException): boolean {
  return ex.platforms.includes(ALL_PLATFORMS) || ex.platforms.includes(cell);
}
function dateCovered(from: string, to: string, ex: RightsException): boolean {
  return ex.validFrom <= from && to <= ex.validTo;
}

/** 例外在评估时点是否处于生效态：已批准 + 到窗口 + 资产版本仍匹配 */
function isEffective(ex: RightsException, at: string, asset: Asset): boolean {
  if (ex.status !== 'approved') return false;
  if (ex.assetId !== asset.id || ex.assetVersion !== asset.version) return false;
  return ex.validFrom <= at && at <= ex.validTo;
}

/** 例外能否覆盖指定 (地域, 平台, 时间窗) 片段 */
export function coversWindow(
  ex: RightsException,
  asset: Asset,
  territory: string,
  platform: string,
  windowFrom: string,
  windowTo: string,
  at: string,
): boolean {
  return (
    isEffective(ex, at, asset) &&
    territoryCovered(territory, ex) &&
    platformCovered(platform, ex) &&
    dateCovered(windowFrom, windowTo, ex)
  );
}

function coversCell(ex: RightsException, cell: ConflictCell, asset: Asset, at: string): boolean {
  return coversWindow(ex, asset, cell.territory, cell.platform, cell.windowFrom, cell.windowTo, at);
}

// ---------- 惰性扫描：到期 / 审批超时（带生效与失效理由事件）----------
export function sweep(at: string = nowIso()): string[] {
  const date = at.slice(0, 10);
  const transitions: string[] = [];
  for (const ex of store.exceptions) {
    if (ex.status === 'pending') {
      // 尚未到生效日的也会计审批 SLA
      if (Date.parse(at) - Date.parse(ex.createdAt) >= APPROVAL_SLA_MS) {
        ex.status = 'timeout';
        ex.decisionComment = '指定审批人 48 小时内未处理，申请自动超时关闭';
        ex.decidedAt = at;
        ex.history.push({ at, action: 'decided', actor: 'system', reason: ex.decisionComment });
        record('EXCEPTION_TIMEOUT', 'rights-exception', ex.id, 'system', ex.decisionComment);
        transitions.push(ex.id);
      }
      continue;
    }
    if (ex.status !== 'approved') continue;
    const asset = liveAsset(ex.assetId);
    if (!asset || ex.assetVersion !== asset.version) {
      ex.status = 'revoked';
      ex.revokeReason = asset
        ? `资产换版至 v${asset.version}，例外仅授予 v${ex.assetVersion}`
        : '资产已从登记册移除';
      ex.revokedAt = at;
      ex.history.push({ at, action: 'ineffective', actor: 'system', reason: ex.revokeReason });
      record('EXCEPTION_DRIFT', 'rights-exception', ex.id, 'system', ex.revokeReason);
      transitions.push(ex.id);
      continue;
    }
    if (date < ex.validFrom && !ex.history.some(h => h.action === 'effective')) {
      // 窗口未到，等待生效
      continue;
    }
    if (date >= ex.validFrom && !ex.history.some(h => h.action === 'effective')) {
      ex.history.push({ at, action: 'effective', actor: 'system', reason: `进入授权窗口 ${ex.validFrom}` });
      record('EXCEPTION_EFFECTIVE', 'rights-exception', ex.id, 'system', `例外生效：${ex.reason}`);
    }
    if (date > ex.validTo) {
      ex.status = 'revoked';
      ex.revokeReason = `例外有效期已于 ${ex.validTo} 届满，风险自动恢复`;
      ex.revokedAt = at;
      ex.history.push({ at, action: 'ineffective', actor: 'system', reason: ex.revokeReason });
      record('EXCEPTION_EXPIRED', 'rights-exception', ex.id, 'system', ex.revokeReason);
      transitions.push(ex.id);
    }
  }
  if (transitions.length) bumpVersion();
  return transitions;
}

// ---------- 评估 ----------
function mapConflict(
  raw: ReturnType<typeof rawConflicts>[number],
  date: string,
): EvaluatedConflict {
  const openCells: ConflictCell[] = [];
  const coveredCells: ConflictCell[] = [];
  const covering = new Set<string>();
  for (const cell of raw.cells) {
    // 收集所有覆盖该格子的生效例外（支持重叠例外互相兜底）
    const hits = store.exceptions.filter(
      ex =>
        (ex.assetId === raw.assetA.id && coversCell(ex, cell, raw.assetA, date)) ||
        (ex.assetId === raw.assetB.id && coversCell(ex, cell, raw.assetB, date)),
    );
    if (hits.length) {
      coveredCells.push(cell);
      hits.forEach(hit => covering.add(hit.id));
    } else openCells.push(cell);
  }
  const status: ConflictStatus =
    openCells.length === 0 ? 'covered' : coveredCells.length === 0 ? 'open' : 'partial';
  return {
    fingerprint: raw.fingerprint,
    assetAId: raw.assetA.id,
    assetBId: raw.assetB.id,
    assetAVersion: raw.assetA.version,
    assetBVersion: raw.assetB.version,
    assetA: raw.assetA.name,
    assetB: raw.assetB.name,
    severity: raw.severity,
    reason: raw.reason,
    active: raw.cells.some(c => c.windowTo >= date),
    cells: raw.cells,
    openCells,
    coveredCells,
    status,
    coveringExceptionIds: [...covering],
  };
}

export function evaluateConflicts(projectId: string, at: string = nowIso()): EvaluatedConflict[] {
  sweep(at);
  const date = at.slice(0, 10);
  return rawConflicts(projectId).map(raw => mapConflict(raw, date));
}

export interface ScopedConflictRow {
  fingerprint: string;
  assetA: string;
  assetB: string;
  severity: Severity;
  status: ConflictStatus; // 只按作用域内格子判定
  scopedCells: { cell: ConflictCell; windowFrom: string; windowTo: string; coveredByExceptionIds: string[] }[];
  coveringExceptionIds: string[];
}

function territoryInScope(cellTerritory: string, scopeTerritories: string[]): boolean {
  return (
    cellTerritory === GLOBAL ||
    scopeTerritories.includes(GLOBAL) ||
    scopeTerritories.includes(cellTerritory)
  );
}
function platformInScope(cellPlatform: string, scopePlatforms: string[]): boolean {
  return (
    cellPlatform === ALL_PLATFORMS ||
    scopePlatforms.includes(ALL_PLATFORMS) ||
    scopePlatforms.includes(cellPlatform)
  );
}

/** 按交付作用域（地域×平台×日期）裁剪后评估：例外只对范围内格子负责 */
export function scopedConflicts(projectId: string, scope: DeliveryScope, at: string = nowIso()): ScopedConflictRow[] {
  sweep(at);
  const date = at.slice(0, 10);
  const rows: ScopedConflictRow[] = [];
  for (const raw of rawConflicts(projectId)) {
    const scopedCells: ScopedConflictRow['scopedCells'] = [];
    for (const cell of raw.cells) {
      if (!territoryInScope(cell.territory, scope.territories)) continue;
      if (!platformInScope(cell.platform, scope.platforms)) continue;
      const from = cell.windowFrom > scope.dateFrom ? cell.windowFrom : scope.dateFrom;
      const to = cell.windowTo < scope.dateTo ? cell.windowTo : scope.dateTo;
      if (to < from) continue;
      const coveredByExceptionIds = store.exceptions
        .filter(
          ex =>
            (ex.assetId === raw.assetA.id &&
              coversWindow(ex, raw.assetA, cell.territory, cell.platform, from, to, date)) ||
            (ex.assetId === raw.assetB.id &&
              coversWindow(ex, raw.assetB, cell.territory, cell.platform, from, to, date)),
        )
        .map(ex => ex.id);
      scopedCells.push({ cell, windowFrom: from, windowTo: to, coveredByExceptionIds });
    }
    if (!scopedCells.length) continue;
    const covered = scopedCells.filter(c => c.coveredByExceptionIds.length);
    const coveringExceptionIds = [...new Set(scopedCells.flatMap(c => c.coveredByExceptionIds))];
    rows.push({
      fingerprint: raw.fingerprint,
      assetA: raw.assetA.name,
      assetB: raw.assetB.name,
      severity: raw.severity,
      status: covered.length === scopedCells.length ? 'covered' : covered.length === 0 ? 'open' : 'partial',
      scopedCells,
      coveringExceptionIds,
    });
  }
  return rows;
}

// ---------- 申请（含重复申请判定）----------
export interface ApplyExceptionInput {
  projectId: string;
  conflictFingerprint?: string;
  assetId: string;
  territories: string[];
  platforms: string[];
  validFrom: string;
  validTo: string;
  reason: string;
  requestedBy: string;
  approver: string;
  clientToken?: string;
}

function normalizeList(list: string[] | undefined, fallback: string[]) {
  const cleaned = (list ?? []).map(s => String(s).trim()).filter(Boolean);
  return cleaned.length ? cleaned : fallback;
}

export function applyException(input: ApplyExceptionInput): { exception: RightsException; deduplicated: boolean } {
  const project = projects.find(p => p.id === input.projectId);
  if (!project) throw new RightsError(404, '项目不存在');
  const asset = seedAssets.find(a => a.id === input.assetId && a.projectId === input.projectId);
  if (!asset) throw new RightsError(404, '申请必须绑定项目内的具体资产');
  const territories = normalizeList(input.territories, [GLOBAL]);
  const platforms = normalizeList(input.platforms, [ALL_PLATFORMS]);
  const validFrom = input.validFrom || todayIso();
  const validTo = input.validTo;
  if (!validTo) throw new RightsError(400, '必须给出例外截止日期（有期限批准）');
  if (validTo < validFrom) throw new RightsError(400, '截止日期不能早于生效日期');
  const days = daysBetween(validFrom, validTo) + 1;
  if (days > MAX_EXCEPTION_DAYS) throw new RightsError(400, `单次例外最长 ${MAX_EXCEPTION_DAYS} 天，请续申请`);
  if (!input.reason.trim()) throw new RightsError(400, '法务必须填写申请理由');
  if (!input.requestedBy.trim() || !input.approver.trim()) throw new RightsError(400, '申请人与指定审批人不能为空');

  const live = liveAsset(asset.id)!;
  const dedupeKey = hash(
    [
      input.projectId,
      asset.id,
      live.version,
      [...territories].sort().join(','),
      [...platforms].sort().join(','),
      validFrom,
      validTo,
      input.reason.trim(),
    ].join('|'),
  );

  // 幂等：相同 clientToken 或同一作用域存在 pending/approved 申请 -> 视为重复申请
  const duplicate = store.exceptions.find(
    ex =>
      (input.clientToken && ex.dedupeKey === `token:${input.clientToken}`) ||
      (ex.dedupeKey === dedupeKey && (ex.status === 'pending' || ex.status === 'approved')),
  );
  if (duplicate) return { exception: duplicate, deduplicated: true };

  const ex: RightsException = {
    id: `EXC-${Date.now().toString(36)}${shortHash(dedupeKey)}`,
    projectId: input.projectId,
    conflictFingerprint: input.conflictFingerprint,
    assetId: asset.id,
    assetVersion: live.version,
    territories,
    platforms,
    validFrom,
    validTo,
    reason: input.reason.trim(),
    requestedBy: input.requestedBy.trim(),
    approver: input.approver.trim(),
    status: 'pending',
    createdAt: nowIso(),
    dedupeKey: input.clientToken ? `token:${input.clientToken}` : dedupeKey,
    history: [{ at: nowIso(), action: 'created', actor: input.requestedBy.trim(), reason: input.reason.trim() }],
  };
  store.exceptions.unshift(ex);
  record('EXCEPTION_APPLY', 'rights-exception', ex.id, ex.requestedBy, `就 ${asset.name} v${ex.assetVersion} 申请 ${validFrom}~${validTo} 的发行例外`);
  bumpVersion();
  return { exception: ex, deduplicated: false };
}

// ---------- 审批（指定审批人 / 拒绝 / 超时）----------
export function decideException(
  id: string,
  decision: 'approved' | 'rejected',
  actor: string,
  comment = '',
): RightsException {
  sweep();
  const ex = store.exceptions.find(item => item.id === id);
  if (!ex) throw new RightsError(404, '例外申请不存在');
  if (ex.status !== 'pending') throw new RightsError(409, `申请当前为 ${ex.status}，不能再审批`);
  if (actor !== ex.approver) throw new RightsError(403, `仅指定审批人「${ex.approver}」可处理该申请`);
  const date = todayIso();
  if (decision === 'approved' && ex.validTo < date) {
    throw new RightsError(409, '申请窗口已过期，不能批准，请法务重新发起');
  }
  ex.status = decision;
  ex.decisionComment = comment || (decision === 'approved' ? '批准有期限例外' : '拒绝例外申请');
  ex.decidedAt = nowIso();
  ex.history.push({
    at: nowIso(),
    action: 'decided',
    actor,
    reason: `${decision === 'approved' ? '批准' : '拒绝'}：${ex.decisionComment}`,
  });
  record(
    decision === 'approved' ? 'EXCEPTION_APPROVE' : 'EXCEPTION_REJECT',
    'rights-exception',
    ex.id,
    actor,
    ex.decisionComment,
  );
  // 批准且窗口已开始 -> 立即记录生效理由
  if (decision === 'approved' && ex.validFrom <= date) {
    ex.history.push({ at: nowIso(), action: 'effective', actor: 'system', reason: `批准即进入授权窗口 ${ex.validFrom}` });
  }
  bumpVersion();
  return ex;
}

// ---------- 撤销（生效中可撤销，风险立即恢复）----------
export function revokeException(id: string, actor: string, reason: string): RightsException {
  sweep();
  const ex = store.exceptions.find(item => item.id === id);
  if (!ex) throw new RightsError(404, '例外申请不存在');
  if (ex.status !== 'approved') throw new RightsError(409, '仅已批准（含生效中）的例外可以撤销');
  if (!reason.trim()) throw new RightsError(400, '撤销必须记录理由');
  // 撤销前先判断在途交付是否只依赖这一条例外（重叠例外仍可兜底时不级联）
  const orphaned: DeliveryManifest[] = [];
  for (const delivery of store.deliveries) {
    if (delivery.status !== 'generating') continue;
    const rows = scopedConflicts(delivery.projectId, delivery.scope);
    const soleCover = rows.some(row =>
      row.scopedCells.some(cell => cell.coveredByExceptionIds.length === 1 && cell.coveredByExceptionIds[0] === id),
    );
    if (soleCover) orphaned.push(delivery);
  }
  ex.status = 'revoked';
  ex.revokeReason = reason.trim();
  ex.revokedAt = nowIso();
  ex.history.push({ at: nowIso(), action: 'revoked', actor, reason: reason.trim() });
  record('EXCEPTION_REVOKE', 'rights-exception', ex.id, actor, reason.trim());
  // 撤销与生成并发：唯一覆盖被撤 -> 依赖格子的在途交付立即失败
  for (const delivery of orphaned) {
    delivery.status = 'failed';
    delivery.failureReason = `生成期间例外 ${ex.id} 被${actor}撤销（${reason.trim()}），该作用域无其他例外兜底`;
    record('DELIVERY_FAIL', 'delivery', delivery.id, 'system', delivery.failureReason);
  }
  bumpVersion();
  return ex;
}

export function listExceptions(projectId: string): RightsException[] {
  sweep();
  return store.exceptions.filter(ex => ex.projectId === projectId);
}

// ---------- 交付预检 ----------
export interface CheckedConflict {
  fingerprint: string;
  assetA: string;
  assetB: string;
  status: ConflictStatus;
  coveringExceptionIds: string[];
}

export function preflight(projectId: string, scope: DeliveryScope, at: string = nowIso()) {
  if (!scope || !scope.territories?.length || !scope.platforms?.length || !scope.dateFrom || !scope.dateTo)
    throw new RightsError(400, '预检范围需包含地域、平台与起止日期');
  if (scope.dateTo < scope.dateFrom) throw new RightsError(400, '交付时间范围无效');
  const rows = scopedConflicts(projectId, scope, at);
  const open = rows.filter(c => c.status !== 'covered');
  const covered = rows.filter(c => c.status === 'covered');
  const verdict: DeliveryVerdict =
    rows.length === 0 ? 'clear' : open.length === 0 ? 'exceptions' : 'blocked';
  const toChecked = (c: ScopedConflictRow): CheckedConflict => ({
    fingerprint: c.fingerprint,
    assetA: c.assetA,
    assetB: c.assetB,
    status: c.status,
    coveringExceptionIds: c.coveringExceptionIds,
  });
  return {
    projectId,
    scope,
    evaluatedAt: at,
    verdict,
    conflicts: rows.map(toChecked),
    realConflicts: open.length,
    coveredByExceptions: covered.length,
    stateVersion: store.stateVersion,
    asOf: at.slice(0, 10),
  };
}

// ---------- 交付生成（OCC + 异步窗口再校验 + 重启恢复）----------
const pendingTimers = new Set<NodeJS.Timeout>();
function clearPendingTimers() {
  pendingTimers.forEach(t => clearTimeout(t));
  pendingTimers.clear();
}

export interface GenerateDeliveryInput {
  projectId: string;
  scope: DeliveryScope;
  requestedBy: string;
  clientToken?: string;
}

export function generateDelivery(input: GenerateDeliveryInput): DeliveryManifest {
  sweep();
  if (input.clientToken) {
    const existing = store.deliveries.find(d => d.clientToken === input.clientToken);
    if (existing) return existing; // 重复提交幂等返回同一 manifest
  }
  const inFlight = store.deliveries.find(
    d => d.projectId === input.projectId && d.status === 'generating',
  );
  if (inFlight) throw new RightsError(409, `该项目已有交付包 ${inFlight.id} 正在生成，请勿重复发起`);

  const check = preflight(input.projectId, input.scope);
  if (check.verdict === 'blocked') {
    throw new RightsError(409, `预检未通过：${check.realConflicts} 处真实/部分未覆盖冲突，不能生成交付包`);
  }
  const manifest: DeliveryManifest = {
    id: `DLV-${Date.now().toString(36)}${shortHash(input.projectId + JSON.stringify(input.scope))}`,
    projectId: input.projectId,
    scope: input.scope,
    requestedBy: input.requestedBy,
    status: 'generating',
    verdict: check.verdict,
    clientToken: input.clientToken,
    stateVersion: check.stateVersion,
    checkedConflicts: check.conflicts,
    createdAt: nowIso(),
    expiresAt: input.scope.dateTo,
  };
  store.deliveries.unshift(manifest);
  record('DELIVERY_START', 'delivery', manifest.id, input.requestedBy, `开始生成交付包（预检 ${check.verdict}，状态版本 ${check.stateVersion}）`);
  bumpVersion();

  // 异步模拟母版打包；提交前重新校验（撤销 / 换版 / 新版本都会使 stateVersion 前进）
  const timer = setTimeout(() => {
    pendingTimers.delete(timer);
    commitDelivery(manifest.id);
  }, generateDelayMs);
  if (typeof timer.unref === 'function') timer.unref();
  pendingTimers.add(timer);
  return manifest;
}

function commitDelivery(id: string) {
  const manifest = store.deliveries.find(d => d.id === id);
  if (!manifest || manifest.status !== 'generating') return; // 已被撤销级联失败
  try {
    const recheck = preflight(manifest.projectId, manifest.scope);
    // 同一批冲突指纹、作用域内状态保持 covered，即允许提交；
    // 覆盖来源从重叠例外 A 切到 B（撤销其一）不算恶化，只有新冲突/出现开放格子才中止
    const sameFingerprints =
      recheck.conflicts.length === manifest.checkedConflicts.length &&
      recheck.conflicts.every(c => {
        const before = manifest.checkedConflicts.find(m => m.fingerprint === c.fingerprint);
        return before && c.status === before.status;
      });
    if (recheck.verdict === 'blocked' || !sameFingerprints) {
      manifest.status = 'failed';
      manifest.failureReason = `生成期间版权状态发生变化（版本 ${manifest.stateVersion} → ${recheck.stateVersion}），已中止，请重新预检`;
      record('DELIVERY_FAIL', 'delivery', manifest.id, 'system', manifest.failureReason);
      bumpVersion();
      return;
    }
    manifest.status = 'ready';
    manifest.stateVersion = recheck.stateVersion;
    manifest.readyAt = nowIso();
    record(
      'DELIVERY_READY',
      'delivery',
      manifest.id,
      manifest.requestedBy,
      recheck.verdict === 'clear' ? '交付包就绪：真实无冲突' : '交付包就绪：全部冲突均在已批准例外作用域内',
    );
    bumpVersion();
  } catch (err) {
    manifest.status = 'failed';
    manifest.failureReason = err instanceof Error ? err.message : '提交前复核失败';
    record('DELIVERY_FAIL', 'delivery', manifest.id, 'system', manifest.failureReason);
    bumpVersion();
  }
}

/** 重启恢复：重新评估在途交付；状态已落盘，恢复时立即复核一次 */
export function recoverOnStartup() {
  sweep();
  for (const delivery of store.deliveries) {
    if (delivery.status !== 'generating') continue;
    // 重启打断了异步计时器：直接按当前版权状态终判
    try {
      const check = preflight(delivery.projectId, delivery.scope);
      if (check.verdict === 'blocked') {
        delivery.status = 'failed';
        delivery.failureReason = '服务重启后复核未通过：存在未覆盖冲突';
      } else {
        delivery.status = 'ready';
        delivery.readyAt = nowIso();
      }
      record(
        delivery.status === 'ready' ? 'DELIVERY_RECOVER_READY' : 'DELIVERY_RECOVER_FAIL',
        'delivery',
        delivery.id,
        'system',
        delivery.status === 'ready' ? '重启恢复：重新校验通过，交付包就绪' : delivery.failureReason!,
      );
    } catch (err) {
      delivery.status = 'failed';
      delivery.failureReason = err instanceof Error ? err.message : '重启恢复失败';
    }
  }
  bumpVersion();
}

export function listDeliveries(projectId: string): DeliveryManifest[] {
  return store.deliveries.filter(d => d.projectId === projectId);
}

// ---------- 版权页 / 驾驶舱汇总 ----------
export function rightsOverview(projectId: string, at: string = nowIso()) {
  const conflicts = evaluateConflicts(projectId, at);
  const exceptions = listExceptions(projectId);
  const active = conflicts.filter(c => c.active);
  const open = active.filter(c => c.status !== 'covered');
  const covered = active.filter(c => c.status === 'covered');
  const partial = active.filter(c => c.status === 'partial');
  return {
    projectId,
    asOf: at.slice(0, 10),
    rawConflictCount: active.length,
    realConflictCount: open.length, // 真实无覆盖风险（含部分覆盖）
    coveredCount: covered.length, // 全部由已批准例外抑制
    partialCount: partial.length,
    conflicts,
    exceptions,
    pendingExceptions: exceptions.filter(e => e.status === 'pending').length,
    activeExceptions: exceptions.filter(e => e.status === 'approved' && e.validFrom <= at.slice(0, 10) && e.validTo >= at.slice(0, 10)).length,
  };
}

/** 驾驶舱：明确区分真实冲突与已批准例外 */
export function dashboardWithRights(at: string = nowIso()) {
  return baseDashboard().map(row => {
    const overview = rightsOverview(row.id as string, at);
    return {
      ...row,
      rightsConflicts: overview.realConflictCount,
      coveredByExceptions: overview.coveredCount,
      partialConflicts: overview.partialCount,
      pendingExceptions: overview.pendingExceptions,
    };
  });
}

// ---------- 演示种子 ----------
export function seedExceptionsForDemo(): RightsException[] {
  const t = todayIso();
  const d = (offset: number) => new Date(Date.parse(t) + offset * MS_PER_DAY).toISOString().slice(0, 10);
  const at = (offsetDays: number) => new Date(Date.parse(t) + offsetDays * MS_PER_DAY).toISOString();
  const mk = (partial: Partial<RightsException> & Pick<RightsException, 'id' | 'projectId' | 'assetId' | 'assetVersion' | 'status' | 'reason' | 'requestedBy' | 'approver'>): RightsException => ({
    conflictFingerprint: partial.conflictFingerprint,
    territories: partial.territories ?? [GLOBAL],
    platforms: partial.platforms ?? [ALL_PLATFORMS],
    validFrom: partial.validFrom ?? d(0),
    validTo: partial.validTo ?? d(30),
    createdAt: partial.createdAt ?? at(-1),
    dedupeKey: partial.dedupeKey ?? `seed:${partial.id}`,
    history: partial.history ?? [],
    ...partial,
  } as RightsException);

  // AST-001 v7 × AST-003 v2：音乐-同步许可，地域 CN/HK/SG/US/CA × 平台{影院,StreamBox,短视频?}
  return [
    // 已批准生效：仅抑制 AST-001 在 CN × 影院 的格子 → 该冲突为 partial
    mk({
      id: 'EXC-DEMO-01',
      projectId: 'PRJ-001',
      assetId: 'AST-001',
      assetVersion: 7,
      territories: ['CN'],
      platforms: ['影院'],
      validFrom: d(-2),
      validTo: d(60),
      status: 'approved',
      reason: '片头曲同步许可在签补发期，申请 CN 影院 60 天过渡发行',
      requestedBy: '法务-周岚',
      approver: '法务总监',
      decidedAt: at(-2),
      decisionComment: '仅限 CN 影院，到期前须补齐许可',
      history: [
        { at: at(-3), action: 'created', actor: '法务-周岚', reason: '片头曲同步许可在签补发期' },
        { at: at(-2), action: 'decided', actor: '法务总监', reason: '批准：仅限 CN 影院' },
        { at: at(-2), action: 'effective', actor: 'system', reason: '进入授权窗口' },
      ],
    }),
    // 已过期：HK × StreamBox 的例外已届满 → 风险恢复
    mk({
      id: 'EXC-DEMO-02',
      projectId: 'PRJ-001',
      assetId: 'AST-003',
      assetVersion: 2,
      territories: ['HK'],
      platforms: ['StreamBox'],
      validFrom: d(-40),
      validTo: d(-5),
      status: 'approved',
      reason: '香港流媒体上线等待同步许可续签',
      requestedBy: '法务-周岚',
      approver: '法务总监',
      decidedAt: at(-40),
      history: [{ at: at(-40), action: 'effective', actor: 'system', reason: '进入授权窗口' }],
    }),
    // 待审批：SG × StreamBox，48h 内（尚未抑制任何格子）
    mk({
      id: 'EXC-DEMO-03',
      projectId: 'PRJ-001',
      assetId: 'AST-001',
      assetVersion: 7,
      territories: ['SG'],
      platforms: ['StreamBox'],
      validFrom: d(0),
      validTo: d(21),
      status: 'pending',
      reason: '新加坡平台方要求先行上线，许可扫描件 7 日内补交',
      requestedBy: '法务-周岚',
      approver: '法务总监',
      createdAt: at(-1),
    }),
    // 已拒绝（终态）
    mk({
      id: 'EXC-DEMO-04',
      projectId: 'PRJ-001',
      assetId: 'AST-002',
      assetVersion: 4,
      territories: [GLOBAL],
      platforms: [ALL_PLATFORMS],
      validFrom: d(0),
      validTo: d(14),
      status: 'rejected',
      reason: '预告音乐希望全球全平台例外使用',
      requestedBy: '法务-周岚',
      approver: '法务总监',
      decidedAt: at(-1),
      decisionComment: '全球全平台范围过大，拒绝；请按具体地域/平台重新申请',
    }),
    // 已撤销（生效中被撤回）：HK × 影院，撤销后该格子风险恢复
    mk({
      id: 'EXC-DEMO-05',
      projectId: 'PRJ-001',
      assetId: 'AST-003',
      assetVersion: 2,
      territories: ['HK'],
      platforms: ['影院'],
      validFrom: d(-20),
      validTo: d(20),
      status: 'revoked',
      reason: '院线点映窗口期安排',
      requestedBy: '法务-周岚',
      approver: '法务总监',
      decidedAt: at(-20),
      revokedAt: at(-6),
      revokeReason: '版权方来函要求立即停止使用，撤销例外',
      history: [
        { at: at(-20), action: 'effective', actor: 'system', reason: '进入授权窗口' },
        { at: at(-6), action: 'revoked', actor: '法务总监', reason: '版权方来函要求立即停止使用' },
      ],
    }),
    // 已批准生效：与 EXC-DEMO-01 重叠覆盖 CN × 影院（演示重叠例外——撤销其中一个，另一个仍兜底）
    mk({
      id: 'EXC-DEMO-06',
      projectId: 'PRJ-001',
      assetId: 'AST-003',
      assetVersion: 2,
      territories: ['CN'],
      platforms: ['影院'],
      validFrom: d(-2),
      validTo: d(60),
      status: 'approved',
      reason: '发行方已取得音乐方邮件确认，院线窗口期补充例外',
      requestedBy: '法务-林澈',
      approver: '法务总监',
      decidedAt: at(0),
      decisionComment: '与 EXC-DEMO-01 重叠，仅作院线兜底',
      history: [
        { at: at(-1), action: 'created', actor: '法务-林澈', reason: '音乐方邮件确认中' },
        { at: at(0), action: 'decided', actor: '法务总监', reason: '批准：院线兜底' },
        { at: at(0), action: 'effective', actor: 'system', reason: '进入授权窗口' },
      ],
    }),
  ];
}

// 磁盘库首次启动时灌入演示种子（原地填充，保持 store 引用一致）
if (store.exceptions.length === 0) {
  store.exceptions.push(...seedExceptionsForDemo());
  store.persist();
}
recoverOnStartup();
