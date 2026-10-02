import test from 'node:test';
import assert from 'node:assert/strict';
import {
  APPROVAL_SLA_MS,
  GLOBAL,
  ALL_PLATFORMS,
  applyException,
  bumpAssetVersion,
  decideException,
  evaluateConflicts,
  generateDelivery,
  getStore,
  listDeliveries,
  listExceptions,
  preflight,
  recoverOnStartup,
  resetForTests,
  revokeException,
  rightsOverview,
  seedExceptionsForDemo,
  setClock,
  setGenerateDelay,
  setStoreForTests,
  sleep,
  type RightsException,
} from './rights.js';

const DAY = 86_400_000;
const base = Date.parse('2026-10-01T09:00:00.000Z');
const iso = (dayOffset: number) => new Date(base + dayOffset * DAY).toISOString().slice(0, 10);

function reset() {
  setClock(() => base);
  setGenerateDelay(30);
  resetForTests();
}

function conflict() {
  const list = evaluateConflicts('PRJ-001');
  const c = list.find(x => x.assetAId === 'AST-001' && x.assetBId === 'AST-003');
  assert.ok(c, 'AST-001 × AST-003 音乐同步许可冲突应存在');
  return c;
}

test('基线：冲突按地域×平台×窗口拆成格子，批准例外只抑制其作用域（partial）', () => {
  reset();
  const c = conflict();
  // 交集地域为 CN（AST-003 仅 CN/US/CA），交集平台为 影院/StreamBox，窗口至 +52 天
  assert.equal(c.status, 'partial');
  assert.ok(c.coveredCells.some(cell => cell.territory === 'CN' && cell.platform === '影院'));
  assert.ok(c.openCells.some(cell => cell.territory === 'CN' && cell.platform === 'StreamBox'));
  assert.deepEqual(c.coveringExceptionIds.sort(), ['EXC-DEMO-01', 'EXC-DEMO-06']);
});

test('驾驶舱与版权页把真实风险与已批准例外分开计数', () => {
  reset();
  const overview = rightsOverview('PRJ-001');
  assert.equal(overview.rawConflictCount, 1, '存在一笔原始冲突');
  assert.equal(overview.realConflictCount, 1, '该冲突为 partial，仍算真实风险');
  assert.equal(overview.coveredCount, 0);
  assert.equal(overview.partialCount, 1);
  assert.ok(overview.exceptions.some(e => e.id === 'EXC-DEMO-03' && e.status === 'pending'));
});

test('覆盖作用域内全部格子时，状态变为 covered（例外抑制而非真实无冲突）', () => {
  reset();
  // 预检 CN×影院：作用域内唯一格子已被例外覆盖 -> exceptions，而非 clear
  const pf = preflight('PRJ-001', { territories: ['CN'], platforms: ['影院'], dateFrom: iso(0), dateTo: iso(30) });
  assert.equal(pf.verdict, 'exceptions');
  assert.equal(pf.realConflicts, 0);
  assert.equal(pf.coveredByExceptions, 1);
});

test('无冲突的项目预检为 clear（真实无冲突）', () => {
  reset();
  const pf = preflight('PRJ-002', { territories: [GLOBAL], platforms: [ALL_PLATFORMS], dateFrom: iso(0), dateTo: iso(60) });
  assert.equal(pf.verdict, 'clear');
  assert.equal(pf.conflicts.length, 0);
});

test('作用域外格子不计入预检：CN 影院已覆盖不代表 CN StreamBox 可以放行', () => {
  reset();
  const blocked = preflight('PRJ-001', { territories: ['CN'], platforms: ['StreamBox'], dateFrom: iso(0), dateTo: iso(30) });
  assert.equal(blocked.verdict, 'blocked');
  const onlyCoveredScope = preflight('PRJ-001', { territories: ['CN'], platforms: ['影院'], dateFrom: iso(0), dateTo: iso(30) });
  assert.equal(onlyCoveredScope.verdict, 'exceptions');
});

test('待审批 / 已拒绝 / 已过期例外不抑制任何风险', () => {
  reset();
  const c = conflict();
  // 待审批的 SG 例外不在交集中；交集中 CN×StreamBox 开放；EXC-DEMO-04 已拒绝
  assert.ok(c.openCells.some(cell => cell.territory === 'CN' && cell.platform === 'StreamBox'));
  assert.ok(!c.coveringExceptionIds.includes('EXC-DEMO-03'));
  // EXC-DEMO-02（HK）不在交集中，它只演示过期 sweep：状态应被置为 revoked 并记录届满
  const expired = listExceptions('PRJ-001').find(e => e.id === 'EXC-DEMO-02');
  assert.equal(expired?.status, 'revoked');
  assert.match(expired?.revokeReason ?? '', /届满/);
});

test('审批必须由指定审批人处理：非指定人 403，指定人可批准/拒绝', () => {
  reset();
  const created = applyException({
    projectId: 'PRJ-001',
    assetId: 'AST-001',
    territories: ['SG'],
    platforms: ['StreamBox'],
    validFrom: iso(0),
    validTo: iso(14),
    reason: '新加坡发行方紧急上线',
    requestedBy: '法务-周岚',
    approver: '法务总监',
  }).exception;
  assert.throws(
    () => decideException(created.id, 'approved', '实习生', '越权批准'),
    /仅指定审批人/,
  );
  const rejected = applyException({
    projectId: 'PRJ-001',
    assetId: 'AST-002',
    territories: ['CN'],
    platforms: ['短视频'],
    validFrom: iso(0),
    validTo: iso(7),
    reason: '预告短视频音乐临时使用',
    requestedBy: '法务-周岚',
    approver: '法务总监',
  }).exception;
  decideException(rejected.id, 'rejected', '法务总监', '范围不清，拒绝');
  assert.equal(rejected.status, 'rejected');
});

test('审批超时（48h 未处理）自动 timeout 且不再抑制风险', () => {
  reset();
  const ex = applyException({
    projectId: 'PRJ-001',
    assetId: 'AST-001',
    territories: ['US'],
    platforms: ['StreamBox'],
    validFrom: iso(0),
    validTo: iso(20),
    reason: '北美平台先行',
    requestedBy: '法务-周岚',
    approver: '法务总监',
  }).exception;
  setClock(() => base + APPROVAL_SLA_MS + 1000);
  const after = listExceptions('PRJ-001').find(e => e.id === ex.id);
  assert.equal(after?.status, 'timeout');
  assert.match(after?.decisionComment ?? '', /超时/);
});

test('批准已过窗口的申请被拒绝（409），必须重新发起', () => {
  reset();
  const ex = applyException({
    projectId: 'PRJ-001',
    assetId: 'AST-001',
    territories: ['US'],
    platforms: ['StreamBox'],
    validFrom: iso(-10),
    validTo: iso(-1),
    reason: '回溯窗口申请',
    requestedBy: '法务-周岚',
    approver: '法务总监',
  }).exception;
  assert.throws(() => decideException(ex.id, 'approved', '法务总监', '补批'), /窗口已过期/);
});

test('撤销生效例外立即恢复风险并记录理由', () => {
  reset();
  assert.ok(conflict().coveredCells.some(c => c.territory === 'CN'));
  revokeException('EXC-DEMO-01', '法务总监', '版权方终止口头同意');
  const c = conflict();
  // 06 仍兜底 CN×影院，所以仍覆盖；再撤销 06 -> 开放
  assert.ok(c.coveredCells.some(x => x.territory === 'CN'));
  revokeException('EXC-DEMO-06', '法务总监', '邮件确认作废');
  const reopened = conflict();
  assert.ok(reopened.openCells.some(x => x.territory === 'CN' && x.platform === '影院'));
  assert.equal(reopened.status, 'open');
});

test('重叠例外：撤销其中一个，另一个继续兜底；全部撤销才恢复风险', () => {
  reset();
  revokeException('EXC-DEMO-06', '法务总监', '先撤兜底');
  let c = conflict();
  assert.ok(c.coveringExceptionIds.includes('EXC-DEMO-01'));
  assert.equal(c.status, 'partial');
  assert.ok(c.coveredCells.some(x => x.territory === 'CN' && x.platform === '影院'));
  revokeException('EXC-DEMO-01', '法务总监', '再撤主例外');
  c = conflict();
  assert.ok(c.openCells.some(x => x.territory === 'CN' && x.platform === '影院'));
});

test('资产换版：绑定旧版本的例外漂移失效，不自动迁移；所有相关资产换版后格子才恢复开放', () => {
  reset();
  // 换版 AST-001：EXC-DEMO-01（绑 AST-001 v7）漂移；EXC-DEMO-06（绑 AST-003）仍兜底
  bumpAssetVersion('AST-001', '后期制片', '母版调色修订');
  const ex = listExceptions('PRJ-001').find(e => e.id === 'EXC-DEMO-01');
  assert.equal(ex?.status, 'revoked');
  assert.match(ex?.revokeReason ?? '', /换版/);
  let c = conflict();
  assert.equal(c.assetAVersion, 8);
  assert.ok(c.coveredCells.some(x => x.territory === 'CN' && x.platform === '影院'), 'AST-003 的重叠例外应继续兜底');
  // 换版 AST-003：兜底例外也漂移，格子恢复开放
  bumpAssetVersion('AST-003', '音乐版权', '片尾曲重混');
  c = conflict();
  assert.equal(c.assetBVersion, 3);
  assert.ok(c.openCells.some(x => x.territory === 'CN' && x.platform === '影院'));
  assert.equal(c.status, 'open');
});

test('全球范围例外（*）抑制所有地域/平台格子', () => {
  reset();
  const ex = applyException({
    projectId: 'PRJ-001',
    assetId: 'AST-003',
    territories: [GLOBAL],
    platforms: [ALL_PLATFORMS],
    validFrom: iso(-2),
    validTo: iso(52),
    reason: '音乐方已签署全球全平台兜底函',
    requestedBy: '法务-周岚',
    approver: '法务总监',
  }).exception;
  decideException(ex.id, 'approved', '法务总监', '凭已签署兜底函批准');
  assert.equal(conflict().status, 'covered');
});

test('例外有最长 90 天上限，且必须填写理由与审批人', () => {
  reset();
  assert.throws(
    () =>
      applyException({
        projectId: 'PRJ-001',
        assetId: 'AST-001',
        territories: ['CN'],
        platforms: ['影院'],
        validFrom: iso(0),
        validTo: iso(120),
        reason: '超长例外',
        requestedBy: '法务-周岚',
        approver: '法务总监',
      }),
    /90 天/,
  );
  assert.throws(
    () =>
      applyException({
        projectId: 'PRJ-001',
        assetId: 'AST-001',
        territories: ['CN'],
        platforms: ['影院'],
        validFrom: iso(0),
        validTo: iso(10),
        reason: '   ',
        requestedBy: '法务-周岚',
        approver: '法务总监',
      }),
    /理由/,
  );
});

test('重复申请：相同作用域的 pending/approved 申请幂等返回；终态后可重新申请', () => {
  reset();
  const input = {
    projectId: 'PRJ-001' as const,
    assetId: 'AST-001',
    territories: ['US'],
    platforms: ['StreamBox'],
    validFrom: iso(5),
    validTo: iso(20),
    reason: '美国流媒体过渡',
    requestedBy: '法务-周岚',
    approver: '法务总监',
  };
  const first = applyException(input);
  assert.equal(first.deduplicated, false);
  const second = applyException(input);
  assert.equal(second.deduplicated, true);
  assert.equal(second.exception.id, first.exception.id);
  // clientToken 也幂等
  const token1 = applyException({ ...input, reason: '另一种措辞的申请', clientToken: 'tok-1' });
  const token2 = applyException({ ...input, reason: '完全不同内容', clientToken: 'tok-1' });
  assert.equal(token1.exception.id, token2.exception.id);
  // 拒绝后同作用域允许重新申请
  decideException(first.exception.id, 'rejected', '法务总监', '先拒绝');
  const again = applyException(input);
  assert.equal(again.deduplicated, false);
});

test('交付预检 blocked 时不能生成；covered(exceptions) 可以生成并异步就绪', async () => {
  reset();
  assert.throws(
    () =>
      generateDelivery({
        projectId: 'PRJ-001',
        scope: { territories: ['CN'], platforms: ['StreamBox'], dateFrom: iso(0), dateTo: iso(30) },
        requestedBy: '发行部',
      }),
    /预检未通过/,
  );
  const manifest = generateDelivery({
    projectId: 'PRJ-001',
    scope: { territories: ['CN'], platforms: ['影院'], dateFrom: iso(0), dateTo: iso(30) },
    requestedBy: '发行部',
    clientToken: 'dlv-1',
  });
  assert.equal(manifest.status, 'generating');
  assert.equal(manifest.verdict, 'exceptions');
  // 重复提交同 token 返回同一交付包
  const dup = generateDelivery({
    projectId: 'PRJ-001',
    scope: { territories: ['CN'], platforms: ['影院'], dateFrom: iso(0), dateTo: iso(30) },
    requestedBy: '发行部',
    clientToken: 'dlv-1',
  });
  assert.equal(dup.id, manifest.id);
  await sleep(60);
  const ready = listDeliveries('PRJ-001').find(d => d.id === manifest.id);
  assert.equal(ready?.status, 'ready');
});

test('撤销与生成并发：生成窗口内撤销所依赖的例外 -> 交付级联失败', async () => {
  reset();
  // 作用域 CN×影院 依赖 01 与 06 双例外
  const manifest = generateDelivery({
    projectId: 'PRJ-001',
    scope: { territories: ['CN'], platforms: ['影院'], dateFrom: iso(0), dateTo: iso(30) },
    requestedBy: '发行部',
  });
  revokeException('EXC-DEMO-01', '法务总监', '生成期间版权方撤回');
  // 06 仍兜底，作用域仍 covered -> 不应失败
  await sleep(60);
  let row = listDeliveries('PRJ-001').find(d => d.id === manifest.id);
  assert.equal(row?.status, 'ready', '重叠例外兜底时交付应继续完成');

  // 再来一次：把两个例外都在生成窗口内撤销 -> 失败
  const manifest2 = generateDelivery({
    projectId: 'PRJ-001',
    scope: { territories: ['CN'], platforms: ['影院'], dateFrom: iso(0), dateTo: iso(30) },
    requestedBy: '发行部',
  });
  revokeException('EXC-DEMO-06', '法务总监', '兜底同样撤回');
  await sleep(60);
  row = listDeliveries('PRJ-001').find(d => d.id === manifest2.id);
  assert.equal(row?.status, 'failed');
  assert.match(row?.failureReason ?? '', /撤销/);
});

test('生成期间无关变更不影响交付；提交前再校验通过才就绪', async () => {
  reset();
  // CN×影院 只依赖 01、06；对 HK 相关资产做不影响作用域的变更（新增被拒申请不改变状态）
  const manifest = generateDelivery({
    projectId: 'PRJ-001',
    scope: { territories: ['CN'], platforms: ['影院'], dateFrom: iso(0), dateTo: iso(30) },
    requestedBy: '发行部',
  });
  // 对一个无关资产（AST-002 不在冲突链）申请被拒：stateVersion 前进但不影响作用域
  const other = applyException({
    projectId: 'PRJ-001',
    assetId: 'AST-002',
    territories: ['CN'],
    platforms: ['短视频'],
    validFrom: iso(0),
    validTo: iso(5),
    reason: '无关申请',
    requestedBy: '法务-周岚',
    approver: '法务总监',
  }).exception;
  decideException(other.id, 'rejected', '法务总监', '拒绝');
  await sleep(60);
  const row = listDeliveries('PRJ-001').find(d => d.id === manifest.id);
  assert.equal(row?.status, 'ready');
});

test('重启恢复：在途生成跨重启后按最新版权状态终判（撤销 -> 失败）', () => {
  reset();
  const manifest = generateDelivery({
    projectId: 'PRJ-001',
    scope: { territories: ['CN'], platforms: ['影院'], dateFrom: iso(0), dateTo: iso(30) },
    requestedBy: '发行部',
  });
  // 模拟进程重启：换一个底层 store 装载相同状态（计时器丢失），再撤掉全部依赖
  const snapshot = getStore();
  resetForTests();
  setStoreForTests(snapshot);
  revokeException('EXC-DEMO-01', '法务总监', '重启前版权方撤回');
  revokeException('EXC-DEMO-06', '法务总监', '重启前兜底撤回');
  recoverOnStartup();
  const row = listDeliveries('PRJ-001').find(d => d.id === manifest.id);
  assert.equal(row?.status, 'failed');
  assert.match(row?.failureReason ?? '', /重启|冲突/);
});

test('重启恢复：在途生成跨重启后复核通过则就绪', () => {
  reset();
  const manifest = generateDelivery({
    projectId: 'PRJ-001',
    scope: { territories: ['CN'], platforms: ['影院'], dateFrom: iso(0), dateTo: iso(30) },
    requestedBy: '发行部',
  });
  const snapshot = getStore();
  resetForTests();
  setStoreForTests(snapshot);
  recoverOnStartup();
  const row = listDeliveries('PRJ-001').find(d => d.id === manifest.id);
  assert.equal(row?.status, 'ready');
});

test('生效与失效理由完整记录在 history 与审计轨迹中', () => {
  reset();
  const ex = applyException({
    projectId: 'PRJ-001',
    assetId: 'AST-001',
    territories: ['JP'],
    platforms: ['StreamBox'],
    validFrom: iso(2),
    validTo: iso(10),
    reason: '日本平台档期要求',
    requestedBy: '法务-周岚',
    approver: '法务总监',
  }).exception;
  // 未到生效日批准：先记录决定，到达窗口日再记录 effective
  decideException(ex.id, 'approved', '法务总监', '凭日方邮件批准');
  let stored = listExceptions('PRJ-001').find(e => e.id === ex.id) as RightsException;
  assert.ok(!stored.history.some(h => h.action === 'effective'), '窗口未到不应记录生效');
  setClock(() => base + 3 * DAY);
  stored = listExceptions('PRJ-001').find(e => e.id === ex.id) as RightsException;
  assert.ok(stored.history.some(h => h.action === 'effective'), '进入窗口应记录生效理由');
  // 过期
  setClock(() => base + 12 * DAY);
  stored = listExceptions('PRJ-001').find(e => e.id === ex.id) as RightsException;
  assert.equal(stored.status, 'revoked');
  assert.ok(stored.history.some(h => h.action === 'ineffective' && /届满/.test(h.reason)));
});
