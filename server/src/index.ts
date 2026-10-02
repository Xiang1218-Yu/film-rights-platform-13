import express from 'express';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  approve,
  assets,
  budgetLines,
  contracts,
  createApproval,
  projectSummary,
  projects,
  rightsConflicts,
  bumpAssetVersion,
} from './domain.js';
import {
  FileExceptionStore,
  InMemoryExceptionStore,
  type ConflictView,
  type ExceptionEventStore,
  type RightsError,
  type PreflightReport,
  type ExceptionView,
  RightsService,
  buildConflicts,
  seedDemoExceptions,
  systemClock,
  recordRightsAudit,
  GLOBAL_TERRITORY,
  ALL_PLATFORMS,
} from './rights.js';

const app = express();
app.use(express.json());

/* ------------------------------------------------------------------ */
/* 装配：事件日志文件存储（重启回放恢复）；测试可通过 EXCEPTIONS_MEMORY 走内存 */
/* ------------------------------------------------------------------ */

let store: ExceptionEventStore;
if (process.env.EXCEPTIONS_MEMORY === '1') {
  store = new InMemoryExceptionStore();
  seedDemoExceptions(store, assets);
} else {
  const path = resolve(process.env.EXCEPTIONS_LOG || './data/rights-exceptions.jsonl');
  mkdirSync(dirname(path), { recursive: true });
  const fileStore = FileExceptionStore.open(path);
  store = fileStore;
  if (fileStore.fresh) seedDemoExceptions(fileStore, assets);
}

const rights = new RightsService(store, { assets });
// 重启恢复后立即扫表：到期 / 超时 / 换版 / 冲突消失的例外落库，风险同步恢复
void rights.sweep();
// 每分钟兜底扫描（真实环境应由工作流调度）
setInterval(() => void rights.sweep(), 60_000).unref();

function errorResponse(res: express.Response, cause: unknown) {
  if ((cause as { status?: number }).status) {
    const error = cause as RightsError;
    return res.status(error.status).json({ message: error.message, code: error.code });
  }
  console.error(cause);
  return res.status(500).json({ message: '服务内部错误' });
}

/* ------------------------------------------------------------------ */
/* 既有端点                                                              */
/* ------------------------------------------------------------------ */

app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'film-rights-platform' }));
app.get('/api/projects', (_req, res) => res.json(projects));

app.get('/api/projects/:id/summary', (req, res) => {
  const result = projectSummary(req.params.id);
  if (!result.project) return res.status(404).json({ message: '项目不存在' });
  res.json(result);
});

// 兼容旧客户端：简要冲突视图
app.get('/api/projects/:id/rights-conflicts', (req, res) => res.json(rightsConflicts(req.params.id)));
app.get('/api/projects/:id/assets', (req, res) => res.json(assets.filter(asset => asset.projectId === req.params.id)));
app.get('/api/projects/:id/contracts', (req, res) => res.json(contracts.filter(contract => contract.projectId === req.params.id)));
app.get('/api/budgets/:projectId/lines', (req, res) => res.json(budgetLines.filter(line => line.projectId === req.params.projectId)));
app.post('/api/approvals', (req, res) => res.status(201).json(createApproval(req.body)));
app.patch('/api/approvals/:id', (req, res) => {
  const result = approve(req.params.id, req.body.status, req.body.comment);
  if (!result) return res.status(404).json({ message: '审批不存在' });
  res.json(result);
});

/* ------------------------------------------------------------------ */
/* 版权例外子系统端点                                                    */
/* ------------------------------------------------------------------ */

// 驾驶舱：区分真实风险（open/partial 残差）与已被例外完整抑制（full）
app.get('/api/rights/dashboard', async (_req, res) => {
  try {
    await rights.sweep();
    const rows = projects.map(project => {
      const summary = projectSummary(project.id);
      const conflicts = rights.listConflicts(project.id);
      const exceptions = rights.listExceptions(project.id);
      const open = conflicts.filter(c => c.suppression === 'open').length;
      const partial = conflicts.filter(c => c.suppression === 'partial').length;
      const fullyExcepted = conflicts.filter(c => c.suppression === 'full').length;
      return {
        id: project.id,
        title: project.title,
        status: project.status,
        forecast: summary.forecast,
        variance: summary.variance,
        pendingApprovals: summary.pendingApprovals,
        rights: {
          totalConflicts: conflicts.length,
          realRisk: open + partial, // 残差 = 真实风险
          openConflicts: open,
          partialConflicts: partial,
          exceptedConflicts: fullyExcepted,
          pendingExceptions: exceptions.filter(e => e.phase === 'pending').length,
          expiringSoon: exceptions.filter(e =>
            e.phase === 'active' && e.effective && daysFromToday(e.effective.to) <= 14).length,
        },
      };
    });
    res.json(rows);
  } catch (cause) {
    errorResponse(res, cause);
  }
});

function daysFromToday(to: string) {
  const today = systemClock.today();
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
}

// 版权页：结构化冲突视图（含残差切片 / 已覆盖切片 / 关联例外）
app.get('/api/projects/:id/rights/conflicts', async (req, res) => {
  try {
    await rights.sweep();
    const result: ConflictView[] = rights.listConflicts(req.params.id);
    res.json(result);
  } catch (cause) {
    errorResponse(res, cause);
  }
});

app.get('/api/projects/:id/rights/exceptions', async (req, res) => {
  try {
    await rights.sweep();
    const result: ExceptionView[] = rights.listExceptions(req.params.id);
    res.json(result);
  } catch (cause) {
    errorResponse(res, cause);
  }
});

// 法务发起有期限例外
app.post('/api/projects/:id/rights/exceptions', async (req, res) => {
  try {
    const result = await rights.requestException({
      projectId: req.params.id,
      conflictFingerprint: req.body.conflictFingerprint,
      scope: req.body.scope,
      justification: req.body.justification,
      requestedBy: req.body.requestedBy ?? '法务-周敏',
      approver: req.body.approver ?? '法务负责人',
    });
    if (!result.deduplicated) {
      recordRightsAudit('EXCEPTION_REQUESTED', result.exception.id, result.exception.requestedBy,
        `申请范围 ${JSON.stringify(result.exception.scope)}；理由：${result.exception.justification}`);
    }
    res.status(result.deduplicated ? 200 : 201).json(result);
  } catch (cause) {
    errorResponse(res, cause);
  }
});

// 指定审批人通过 / 驳回
app.post('/api/rights/exceptions/:id/decision', async (req, res) => {
  try {
    const result = await rights.decide(
      req.params.id,
      req.body.decision,
      req.body.actor ?? '法务负责人',
      req.body.comment,
      typeof req.body.expectedRevision === 'number' ? req.body.expectedRevision : undefined,
    );
    recordRightsAudit(
      req.body.decision === 'approved' ? 'EXCEPTION_APPROVED' : 'EXCEPTION_REJECTED',
      result.id, req.body.actor ?? '法务负责人',
      req.body.decision === 'approved'
        ? `批准例外，抑制范围：${JSON.stringify(result.scope)}（${req.body.comment ?? ''}）`
        : `驳回例外：${req.body.comment ?? ''}`,
    );
    res.json(result);
  } catch (cause) {
    errorResponse(res, cause);
  }
});

// 撤销：风险恢复
app.post('/api/rights/exceptions/:id/revoke', async (req, res) => {
  try {
    const result = await rights.revoke(req.params.id, req.body.actor ?? '法务-周敏', req.body.reason ?? '');
    recordRightsAudit('EXCEPTION_REVOKED', result.id, req.body.actor ?? '法务-周敏', req.body.reason);
    res.json(result);
  } catch (cause) {
    errorResponse(res, cause);
  }
});

// 资产换版：旧版本上的例外全部 stale
app.post('/api/assets/:id/version', async (req, res) => {
  try {
    const result = bumpAssetVersion(req.params.id, req.body.actor);
    if (!result) return res.status(404).json({ message: '资产不存在' });
    await rights.onAssetVersioned(result.asset.id, result.oldVersion, result.newVersion);
    recordRightsAudit('ASSET_VERSIONED', result.asset.id, req.body.actor ?? '当前用户',
      `v${result.oldVersion} → v${result.newVersion}，关联例外失效`);
    res.json(result);
  } catch (cause) {
    errorResponse(res, cause);
  }
});

// 交付预检：clean（真实无冲突）/ exception（凭已批准例外放行）/ blocked（残差风险阻断）
app.post('/api/projects/:id/rights/preflight', async (req, res) => {
  try {
    const report: PreflightReport = await rights.preflight(req.params.id, {
      territories: req.body.territories,
      platforms: req.body.platforms,
      dates: req.body.dates ?? { from: systemClock.today(), to: projects.find(p => p.id === req.params.id)?.deliveryDate },
      assetIds: req.body.assetIds,
    });
    res.json(report);
  } catch (cause) {
    errorResponse(res, cause);
  }
});

// 供前端表单展示可选地域 / 平台
app.get('/api/rights/dimensions', (_req, res) => {
  const territories = new Set<string>();
  const platforms = new Set<string>();
  assets.forEach((asset) => {
    asset.territories.forEach((t) => territories.add(t));
    asset.platforms.forEach((p) => platforms.add(p));
  });
  res.json({
    territories: [...territories].sort(),
    platforms: [...platforms].sort(),
    globalTerritory: GLOBAL_TERRITORY,
    allPlatforms: ALL_PLATFORMS,
  });
});

// 启动期诊断：冲突总数（用于冒烟检查）
app.get('/api/rights/debug/conflicts', (_req, res) => {
  res.json(projects.map(p => ({ projectId: p.id, conflicts: buildConflicts(assets, p.id).map(c => ({ fp: c.fingerprint, pair: c.names })) })));
});

const port = Number(process.env.PORT || 4104);
app.listen(port, () => console.log(`film rights API listening on ${port}`));
