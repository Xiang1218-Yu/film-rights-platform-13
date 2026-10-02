import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Asset, AssetType } from './domain.js';
import {
  buildConflicts,
  createRightsService,
  fakeClock,
  FileExceptionStore,
  InMemoryExceptionStore,
  RightsService,
  GLOBAL_TERRITORY,
  ALL_PLATFORMS,
  seedDemoExceptions,
  type ExceptionScope,
} from './rights.js';

/* ---- 测试装置：四件资产、多个重叠冲突 ---- */

function asset(id: string, version: number, part: Partial<Asset>): Asset {
  return {
    id, projectId: 'PRJ-T', name: id, type: 'master' as AssetType, status: 'review',
    owner: 't', checksum: 'sha256:x', territories: ['CN'], platforms: ['StreamBox'],
    availableFrom: '2026-01-01', availableTo: '2026-12-31', rightsTags: [], version, ...part,
  };
}

const baseAssets = () => ([
  asset('A', 1, { territories: ['全球'], platforms: ['影院'], rightsTags: ['音乐-同步许可'] }),
  asset('B', 2, { territories: ['CN', 'US'], platforms: ['影院', 'StreamBox'], rightsTags: ['音乐-同步许可'] }),
  asset('C', 3, { territories: ['CN'], platforms: ['StreamBox'], rightsTags: ['音乐-同步许可'], status: 'locked' }),
  asset('D', 4, { territories: ['US'], platforms: ['影院'], rightsTags: [], availableFrom: '2027-01-01', availableTo: '2027-12-31' }),
]);

function setup(assets = baseAssets()) {
  const clock = fakeClock();
  const inner = createRightsService({ assets, clock, slaHours: 48, maxWindowDays: 90 });
  return { service: inner.service, store: inner.store, clock, assets: inner.assets };
}

const fullScopeCN = (): ExceptionScope => ({
  territories: ['CN'], platforms: ['*'],
  dates: { from: '2026-09-15', to: '2026-12-10' }, tags: [],
});

test('冲突引擎产出稳定指纹与精确重叠维度', () => {
  const conflicts = buildConflicts(baseAssets(), 'PRJ-T');
  // A↔B（全球×影院）、B↔C（CN×StreamBox）；A↔C 平台与地域均不重叠，D 无标签且窗口不重叠
  assert.equal(conflicts.length, 2);
  const ab = conflicts.find((c) => c.pair.join() === 'A,B')!;
  const ab2 = buildConflicts(baseAssets(), 'PRJ-T').find((c) => c.pair.join() === 'A,B')!;
  assert.equal(ab.fingerprint, ab2.fingerprint);
  assert.deepEqual(ab.territories, ['CN', 'US']);
  assert.deepEqual(ab.platforms, ['影院']);
  const bc = conflicts.find((c) => c.pair.join() === 'B,C')!;
  assert.equal(bc.severity, 'critical');
  assert.deepEqual(bc.platforms, ['StreamBox']);
  assert.deepEqual(bc.territories, ['CN']);
});

test('无例外时冲突为 open，待审批例外不抑制任何范围', async () => {
  const { service } = setup();
  const ab = buildConflicts(baseAssets(), 'PRJ-T').find((c) => c.pair.join() === 'A,B')!;
  let views = service.listConflicts('PRJ-T');
  assert.equal(views.every((v) => v.suppression === 'open'), true);
  await service.requestException({
    projectId: 'PRJ-T', conflictFingerprint: ab.fingerprint,
    scope: fullScopeCN(), justification: '法务测试', requestedBy: '法务', approver: '法务负责人',
  });
  views = service.listConflicts('PRJ-T');
  const view = views.find((v) => v.fingerprint === ab.fingerprint)!;
  assert.equal(view.suppression, 'open');
  assert.equal(view.exceptions[0].phase, 'pending');
  assert.match(view.exceptions[0].ineffectivenessReason ?? '', /等待指定审批人/);
});

test('批准后只抑制申请范围：部分抑制产生残差切片', async () => {
  const { service } = setup();
  const ab = buildConflicts(baseAssets(), 'PRJ-T').find((c) => c.pair.join() === 'A,B')!;
  // 仅 CN/影院/9.15-10.15；冲突本身覆盖 CN+US、影院、全年
  const scope: ExceptionScope = {
    territories: ['CN'], platforms: ['影院'],
    dates: { from: '2026-09-15', to: '2026-10-15' }, tags: [],
  };
  const { exception } = await service.requestException({
    projectId: 'PRJ-T', conflictFingerprint: ab.fingerprint,
    scope, justification: 'CN 点映限窗', requestedBy: '法务', approver: '法务负责人',
  });
  const decided = await service.decide(exception.id, 'approved', '法务负责人', '同意 CN 点映限窗');
  assert.equal(decided.phase, 'active');
  const view = service.listConflicts('PRJ-T').find((v) => v.fingerprint === ab.fingerprint)!;
  assert.equal(view.suppression, 'partial');
  // 覆盖切片：CN×影院×9.15-10.15
  assert.equal(view.coveredSlices.length, 1);
  assert.deepEqual(view.coveredSlices[0].territories, ['CN']);
  assert.deepEqual(view.coveredSlices[0].platforms, ['影院']);
  assert.equal(view.coveredSlices[0].from, '2026-09-15');
  assert.equal(view.coveredSlices[0].to, '2026-10-15');
  // 面向今天的残差：US 全年（视界内段）+ CN 窗口外的未来段
  const usResidual = view.residualSlices.filter((s) => s.territories.includes('US'));
  assert.ok(usResidual.length >= 1);
  const cnResidual = view.residualSlices.filter((s) => s.territories.includes('CN'));
  assert.deepEqual(cnResidual.map((s) => [s.from, s.to]), [['2026-10-16', '2026-12-31']]);
  // 历史残差单独存放（9.15 之前），不计入风险
  const cnHistory = view.historicalSlices.filter((s) => s.territories.includes('CN'));
  assert.deepEqual(cnHistory.map((s) => [s.from, s.to]), [['2026-01-01', '2026-09-14']]);
});

test('全球例外（全球 + 全平台）完整覆盖时冲突显示 full 但标记为已批准例外', async () => {
  const clock = fakeClock();
  const { service } = createRightsService({ assets: baseAssets(), clock, maxWindowDays: 365 });
  const bc = buildConflicts(baseAssets(), 'PRJ-T').find((c) => c.pair.join() === 'B,C')!;
  const scope: ExceptionScope = {
    territories: [GLOBAL_TERRITORY], platforms: [ALL_PLATFORMS],
    dates: { from: '2026-09-15', to: '2026-12-31' }, tags: [],
  };
  const { exception } = await service.requestException({
    projectId: 'PRJ-T', conflictFingerprint: bc.fingerprint,
    scope, justification: '全球全平台短窗', requestedBy: '法务', approver: '法务负责人',
  });
  await service.decide(exception.id, 'approved', '法务负责人', '全球短窗放行');
  const view = service.listConflicts('PRJ-T').find((v) => v.fingerprint === bc.fingerprint)!;
  assert.equal(view.suppression, 'full');
  assert.equal(view.residualSlices.length, 0);
  assert.equal(view.coveredSlices.length >= 1, true);
  // full 不等于无冲突：视图仍保留例外明细与覆盖切片
  assert.equal(view.exceptions[0].status, 'approved');
});

test('驳回不抑制并记录理由', async () => {
  const { service } = setup();
  const ab = buildConflicts(baseAssets(), 'PRJ-T').find((c) => c.pair.join() === 'A,B')!;
  const { exception } = await service.requestException({
    projectId: 'PRJ-T', conflictFingerprint: ab.fingerprint,
    scope: fullScopeCN(), justification: 'x', requestedBy: '法务', approver: '法务负责人',
  });
  const decided = await service.decide(exception.id, 'rejected', '法务负责人', '版权方未确认，驳回');
  assert.equal(decided.phase, 'rejected');
  assert.match(decided.ineffectivenessReason ?? '', /驳回/);
  const view = service.listConflicts('PRJ-T').find((v) => v.fingerprint === ab.fingerprint)!;
  assert.equal(view.suppression, 'open');
});

test('超过 SLA 未审批，扫表后 timedout 且风险恢复', async () => {
  const clock = fakeClock();
  const { service } = createRightsService({ assets: baseAssets(), clock, slaHours: 48 });
  const ab = buildConflicts(baseAssets(), 'PRJ-T').find((c) => c.pair.join() === 'A,B')!;
  const { exception } = await service.requestException({
    projectId: 'PRJ-T', conflictFingerprint: ab.fingerprint,
    scope: fullScopeCN(), justification: 'x', requestedBy: '法务', approver: '法务负责人',
  });
  clock.advanceHours(49);
  await service.sweep();
  const view = service.listConflicts('PRJ-T').find((v) => v.fingerprint === ab.fingerprint)!;
  assert.equal(view.exceptions.find((e) => e.id === exception.id)?.phase, 'timedout');
  assert.match(view.exceptions.find((e) => e.id === exception.id)?.ineffectivenessReason ?? '', /超过审批时限/);
  assert.equal(view.suppression, 'open');
});

test('到期后扫表恢复风险，并记录到期理由', async () => {
  const clock = fakeClock();
  const { service } = createRightsService({ assets: baseAssets(), clock });
  const ab = buildConflicts(baseAssets(), 'PRJ-T').find((c) => c.pair.join() === 'A,B')!;
  const scope: ExceptionScope = {
    territories: ['CN'], platforms: ['影院'],
    dates: { from: '2026-09-15', to: '2026-09-20' }, tags: [],
  };
  const { exception } = await service.requestException({
    projectId: 'PRJ-T', conflictFingerprint: ab.fingerprint,
    scope, justification: '短窗', requestedBy: '法务', approver: '法务负责人',
  });
  await service.decide(exception.id, 'approved', '法务负责人', '短窗');
  clock.advanceDays(6);
  await service.sweep();
  const view = service.listConflicts('PRJ-T').find((v) => v.fingerprint === ab.fingerprint)!;
  assert.equal(view.exceptions[0].phase, 'expired');
  assert.match(view.exceptions[0].ineffectivenessReason ?? '', /已到期/);
  assert.equal(view.suppression, 'open');
});

test('撤销与决定并发：后到的决定因 revision 冲突失败，撤销生效', async () => {
  const { service } = setup();
  const ab = buildConflicts(baseAssets(), 'PRJ-T').find((c) => c.pair.join() === 'A,B')!;
  const { exception } = await service.requestException({
    projectId: 'PRJ-T', conflictFingerprint: ab.fingerprint,
    scope: fullScopeCN(), justification: 'x', requestedBy: '法务', approver: '法务负责人',
  });
  await service.decide(exception.id, 'approved', '法务负责人', 'ok', 0);
  // 审批人拿着旧 revision=0 的页面点“驳回”；法务同时已撤销
  await service.revoke(exception.id, '法务', '版权方回函拒绝');
  await assert.rejects(
    service.decide(exception.id, 'rejected', '法务负责人', '迟来的驳回', 0),
    /revision|状态/,
  );
  const views = service.listConflicts('PRJ-T').find((v) => v.fingerprint === ab.fingerprint)!;
  assert.equal(views.exceptions[0].phase, 'revoked');
  assert.equal(views.suppression, 'open');
});

test('重复申请（同冲突同范围同状态）幂等返回原单', async () => {
  const { service } = setup();
  const ab = buildConflicts(baseAssets(), 'PRJ-T').find((c) => c.pair.join() === 'A,B')!;
  const input = {
    projectId: 'PRJ-T', conflictFingerprint: ab.fingerprint,
    scope: fullScopeCN(), justification: 'x', requestedBy: '法务', approver: '法务负责人',
  };
  const first = await service.requestException(input);
  const second = await service.requestException({ ...input, justification: '不同文案不影响去重' });
  assert.equal(first.deduplicated, false);
  assert.equal(second.deduplicated, true);
  assert.equal(first.exception.id, second.exception.id);
});

test('重叠例外可叠加：两个不同子范围共同拼满完整范围', async () => {
  const { service } = setup();
  const bc = buildConflicts(baseAssets(), 'PRJ-T').find((c) => c.pair.join() === 'B,C')!;
  const input = (from: string, to: string) => ({
    projectId: 'PRJ-T' as const, conflictFingerprint: bc.fingerprint,
    scope: { territories: ['CN'], platforms: ['StreamBox'], dates: { from, to }, tags: [] } as ExceptionScope,
    justification: '拼窗', requestedBy: '法务', approver: '法务负责人',
  });
  const e1 = await service.requestException(input('2026-09-15', '2026-10-31'));
  const e2 = await service.requestException(input('2026-11-01', '2026-12-10'));
  await service.decide(e1.exception.id, 'approved', '法务负责人', '第一段');
  await service.decide(e2.exception.id, 'approved', '法务负责人', '第二段');
  const view = service.listConflicts('PRJ-T').find((v) => v.fingerprint === bc.fingerprint)!;
  // 9.15-12.10 被覆盖，视界内仅 12.11-12.31 残差 → partial（1-9.14 属历史残差）
  assert.equal(view.suppression, 'partial');
  assert.deepEqual(view.residualSlices.map((s) => [s.from, s.to]),
    [['2026-12-11', '2026-12-31']]);
  assert.deepEqual(view.historicalSlices.map((s) => [s.from, s.to]),
    [['2026-01-01', '2026-09-14']]);
});

test('资产换版：已批准例外 stale，不再抑制；重新申请按新版本生效', async () => {
  const { service, assets: internal } = setup();
  const ab = buildConflicts(internal, 'PRJ-T').find((c) => c.pair.join() === 'A,B')!;
  const { exception } = await service.requestException({
    projectId: 'PRJ-T', conflictFingerprint: ab.fingerprint,
    scope: fullScopeCN(), justification: 'x', requestedBy: '法务', approver: '法务负责人',
  });
  await service.decide(exception.id, 'approved', '法务负责人', 'ok');
  // B 从 v2 换版为 v3（直接改服务内部使用的资产数组）
  const assetB = internal.find((a) => a.id === 'B')!;
  const old = assetB.version;
  assetB.version += 1;
  await service.onAssetVersioned('B', old, assetB.version);
  // 旧指纹冲突已消失：直接查看该例外状态
  const staleView = service.listExceptions('PRJ-T').find((e) => e.id === exception.id)!;
  assert.equal(staleView.phase, 'stale');
  assert.match(staleView.ineffectivenessReason ?? '', /换版/);
  // 新指纹冲突为 open（旧例外不再抑制），且同资产对视图上能追溯到 stale 历史
  // 换版后指纹变化，旧指纹申请不到；对新指纹重新申请可再次抑制
  const ab2 = buildConflicts(internal, 'PRJ-T').find((c) => c.pair.join() === 'A,B')!;
  assert.notEqual(ab2.fingerprint, ab.fingerprint);
  let view = service.listConflicts('PRJ-T').find((v) => v.fingerprint === ab2.fingerprint)!;
  assert.equal(view.suppression, 'open');
  assert.ok(view.exceptions.some((e) => e.phase === 'stale'));
  const retry = await service.requestException({
    projectId: 'PRJ-T', conflictFingerprint: ab2.fingerprint,
    scope: fullScopeCN(), justification: '换版后重新申请', requestedBy: '法务', approver: '法务负责人',
  });
  await service.decide(retry.exception.id, 'approved', '法务负责人', '新版本放行');
  view = service.listConflicts('PRJ-T').find((v) => v.fingerprint === ab2.fingerprint)!;
  assert.equal(view.suppression, 'partial'); // CN 全覆盖但 US 仍残差
});

test('交付预检区分 clean / exception / blocked，且撤销后立即 blocked', async () => {
  const { service } = setup();
  const bc = buildConflicts(baseAssets(), 'PRJ-T').find((c) => c.pair.join() === 'B,C')!;
  const target = { territories: ['CN'], platforms: ['StreamBox'], dates: { from: '2026-09-20', to: '2026-10-01' } };
  assert.equal((await service.preflight('PRJ-T', target)).verdict, 'blocked');
  const { exception } = await service.requestException({
    projectId: 'PRJ-T', conflictFingerprint: bc.fingerprint,
    scope: { territories: ['CN'], platforms: ['StreamBox'], dates: { from: '2026-09-15', to: '2026-10-15' }, tags: [] },
    justification: '交付窗口', requestedBy: '法务', approver: '法务负责人',
  });
  await service.decide(exception.id, 'approved', '法务负责人', 'ok');
  const pass = await service.preflight('PRJ-T', target);
  assert.equal(pass.verdict, 'exception');
  assert.deepEqual(pass.usedExceptions, [exception.id]);
  await service.revoke(exception.id, '法务', '撤回许可');
  assert.equal((await service.preflight('PRJ-T', target)).verdict, 'blocked');
});

test('交付预检范围裁剪：不涉及冲突维度的目标是 clean', async () => {
  const { service } = setup();
  // US×影院 × 2027 窗口：所有冲突都在 2026 年内
  const report = await service.preflight('PRJ-T', {
    territories: ['US'], platforms: ['影院'],
    dates: { from: '2027-01-01', to: '2027-02-01' },
  });
  assert.equal(report.verdict, 'clean');
  assert.equal(report.conflictCount, 0);
});

test('校验：越界范围、缺理由、超最长窗口、过去日期均被拒绝', async () => {
  const { service } = setup();
  const ab = buildConflicts(baseAssets(), 'PRJ-T').find((c) => c.pair.join() === 'A,B')!;
  const base = {
    projectId: 'PRJ-T' as const, conflictFingerprint: ab.fingerprint,
    scope: fullScopeCN(), justification: '理由', requestedBy: '法务', approver: '法务负责人',
  };
  await assert.rejects(service.requestException({
    ...base, scope: { ...fullScopeCN(), territories: ['JP'] },
  }), /无交集/);
  await assert.rejects(service.requestException({ ...base, justification: '  ' }), /业务理由/);
  await assert.rejects(service.requestException({
    ...base, scope: { ...fullScopeCN(), dates: { from: '2026-09-15', to: '2026-12-16' } },
  }), /最长/);
  await assert.rejects(service.requestException({
    ...base, scope: { ...fullScopeCN(), dates: { from: '2026-09-01', to: '2026-09-10' } },
  }), /不能早于今天/);
});

test('事件日志持久化：写文件、冷启动回放后状态与抑制结果一致', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rights-log-'));
  try {
    const path = join(dir, 'exceptions.jsonl');
    const store1 = FileExceptionStore.open(path);
    assert.equal(store1.fresh, true);
    const clock = fakeClock();
    const svc1 = new RightsService(store1, { assets: baseAssets(), clock });
    const ab = buildConflicts(baseAssets(), 'PRJ-T').find((c) => c.pair.join() === 'A,B')!;
    const { exception } = await svc1.requestException({
      projectId: 'PRJ-T', conflictFingerprint: ab.fingerprint,
      scope: { territories: ['CN'], platforms: ['影院'], dates: { from: '2026-09-15', to: '2026-10-15' }, tags: [] },
      justification: '持久化', requestedBy: '法务', approver: '法务负责人',
    });
    await svc1.decide(exception.id, 'approved', '法务负责人', 'ok');

    const lines = readFileSync(path, 'utf8').trim().split('\n');
    assert.equal(lines.length, 2); // requested + decided
    assert.equal(JSON.parse(lines[0]).kind, 'requested');

    // 冷启动：仅追加日志回放
    const store2 = FileExceptionStore.open(path);
    assert.equal(store2.fresh, false);
    const svc2 = new RightsService(store2, { assets: baseAssets(), clock: fakeClock() });
    const views = svc2.listConflicts('PRJ-T').find((v) => v.fingerprint === ab.fingerprint)!;
    assert.equal(views.suppression, 'partial');
    assert.equal(views.exceptions[0].status, 'approved');
    assert.equal(views.exceptions[0].revision, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('演示种子在真实项目数据上可装配并产出 partial/open/full 混合视图', async () => {
  // 复用 domain 的演示资产（动态 import 避免顶部循环）
  const { assets: demoAssets } = await import('./domain.js');
  const store = new InMemoryExceptionStore();
  seedDemoExceptions(store, demoAssets, fakeClock());
  const svc = new RightsService(store, { assets: demoAssets, clock: fakeClock() });
  await svc.sweep(); // EXC-104 超时
  const p1 = svc.listConflicts('PRJ-001');
  const p2 = svc.listConflicts('PRJ-002');
  // PRJ-002 的节展例外只覆盖短窗短平台 → partial
  assert.ok(p2.some((c) => c.suppression === 'partial'));
  // PRJ-001 至少有一条 open（EXC-103 撤销 / EXC-104 超时 / EXC-102 待批）
  assert.ok(p1.some((c) => c.suppression === 'open'));
  const phases = svc.listExceptions('PRJ-001').map((e) => e.phase);
  assert.ok(phases.includes('revoked'));
  assert.ok(phases.includes('timedout'));
  assert.ok(phases.includes('pending'));
  // 每个例外都带生效 / 失效理由
  for (const e of svc.listExceptions('PRJ-001').concat(svc.listExceptions('PRJ-002'))) {
    assert.ok(e.effectivenessReason || e.ineffectivenessReason, `${e.id} 缺少理由`);
    assert.ok(e.history.length >= 1);
  }
});
