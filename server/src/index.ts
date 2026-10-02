import express from 'express';
import { approve, assets, budgetLines, contracts, createApproval, projectSummary, projects, rightsConflicts } from './domain.js';
import {
  RightsError,
  applyException,
  bumpAssetVersion,
  dashboardWithRights,
  decideException,
  evaluateConflicts,
  generateDelivery,
  listDeliveries,
  listExceptions,
  preflight,
  recoverOnStartup,
  rightsOverview,
  revokeException,
  type DeliveryScope,
} from './rights.js';

const app = express();
app.use(express.json());
const p = (req: express.Request, name: string) => String(req.params[name]);

const handle = (handler: express.RequestHandler): express.RequestHandler => async (req, res, next) => {
  try {
    await handler(req, res, next);
  } catch (err) {
    if (err instanceof RightsError) return res.status(err.code).json({ message: err.message });
    return res.status(500).json({ message: err instanceof Error ? err.message : '服务异常' });
  }
};

app.get('/api/dashboard', handle((_req, res) => res.json(dashboardWithRights())));
app.get('/api/projects', (_req, res) => res.json(projects));
app.get('/api/projects/:id/summary', (req, res) => { const result = projectSummary(p(req, 'id')); if (!result.project) return res.status(404).json({ message: '项目不存在' }); res.json(result); });
// 旧接口：原始冲突（不区分例外），保留兼容
app.get('/api/projects/:id/rights-conflicts', (req, res) => res.json(rightsConflicts(p(req, 'id'))));
// 新接口：逐格子评估，区分真实风险 / 部分例外 / 已批准例外覆盖
app.get('/api/projects/:id/rights/overview', handle((req, res) => res.json(rightsOverview(p(req, 'id')))));
app.get('/api/projects/:id/rights/conflicts', handle((req, res) => res.json(evaluateConflicts(p(req, 'id')))));
app.get('/api/projects/:id/rights/exceptions', handle((req, res) => res.json(listExceptions(p(req, 'id')))));
app.get('/api/projects/:id/assets', (req, res) => res.json(assets.filter(asset => asset.projectId === p(req, 'id'))));
app.get('/api/projects/:id/contracts', (req, res) => res.json(contracts.filter(contract => contract.projectId === p(req, 'id'))));
app.get('/api/budgets/:projectId/lines', (req, res) => res.json(budgetLines.filter(line => line.projectId === p(req, 'projectId'))));

app.post('/api/approvals', (req, res) => res.status(201).json(createApproval(req.body)));
app.patch('/api/approvals/:id', (req, res) => { const result = approve(p(req, 'id'), req.body.status, req.body.comment); if (!result) return res.status(404).json({ message: '审批不存在' }); res.json(result); });

// ---- 版权例外工作流 ----
// 法务发起有期限、可撤销例外申请（重复申请幂等返回）
app.post(
  '/api/projects/:id/rights/exceptions',
  handle((req, res) => {
    const result = applyException({ ...req.body, projectId: p(req, 'id') });
    res.status(result.deduplicated ? 200 : 201).json(result);
  }),
);
// 指定审批人批准 / 拒绝
app.post(
  '/api/rights/exceptions/:exId/decision',
  handle((req, res) => res.json(decideException(p(req, 'exId'), req.body.decision, req.body.actor, req.body.comment))),
);
// 撤销生效中的例外（风险立即恢复；级联中止依赖它的在途交付）
app.post(
  '/api/rights/exceptions/:exId/revoke',
  handle((req, res) => res.json(revokeException(p(req, 'exId'), req.body.actor, req.body.reason))),
);
// 资产换版：绑定旧版本的例外漂移失效，不自动迁移
app.post(
  '/api/assets/:assetId/bump-version',
  handle((req, res) => res.json(bumpAssetVersion(p(req, 'assetId'), req.body.actor ?? '当前用户', req.body.note))),
);

// ---- 交付预检与生成 ----
app.post(
  '/api/projects/:id/delivery/preflight',
  handle((req, res) => res.json(preflight(p(req, 'id'), req.body.scope as DeliveryScope))),
);
app.post(
  '/api/projects/:id/delivery/generate',
  handle((req, res) =>
    res.status(202).json(
      generateDelivery({
        projectId: p(req, 'id'),
        scope: req.body.scope as DeliveryScope,
        requestedBy: req.body.requestedBy ?? '发行部',
        clientToken: req.body.clientToken,
      }),
    ),
  ),
);
app.get('/api/projects/:id/deliveries', handle((req, res) => res.json(listDeliveries(p(req, 'id')))));
// 管理接口：演示重启恢复
app.post('/api/system/recover', handle((_req, res) => { recoverOnStartup(); res.json({ ok: true }); }));

app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'film-rights-platform' }));

const port = Number(process.env.PORT || 4104);
app.listen(port, () => console.log(`film rights API listening on ${port}`));
