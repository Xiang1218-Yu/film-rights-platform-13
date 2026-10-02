export type ProjectStatus = 'development' | 'production' | 'post' | 'delivered';
export type AssetType = 'master' | 'trailer' | 'poster' | 'audio' | 'subtitle';
export type ApprovalStatus = 'pending' | 'approved' | 'rejected';

import { buildConflicts } from './rights.js';

export interface Project { id: string; code: string; title: string; season: number; status: ProjectStatus; currency: string; budgetVersionId: string; deliveryDate: string; }
export interface BudgetLine { id: string; projectId: string; category: string; subcategory: string; planned: number; committed: number; actual: number; forecast: number; owner: string; risk: 'low' | 'medium' | 'high'; }
export interface Contract { id: string; projectId: string; vendor: string; scope: string; ceiling: number; committed: number; paid: number; milestones: { name: string; due: string; amount: number; status: 'open' | 'invoiced' | 'paid' }[]; }
export interface Asset { id: string; projectId: string; name: string; type: AssetType; version: number; status: 'draft' | 'review' | 'approved' | 'locked'; owner: string; checksum: string; territories: string[]; platforms: string[]; availableFrom: string; availableTo: string; rightsTags: string[]; }
export interface Approval { id: string; projectId: string; entityType: 'budget' | 'asset' | 'delivery'; entityId: string; title: string; requestedBy: string; status: ApprovalStatus; approver: string; createdAt: string; comment?: string; }
export interface AuditEvent { id: string; action: string; entity: string; entityId: string; actor: string; at: string; details: string; }

const now = Date.now();
const iso = (days: number) => new Date(now + days * 86400000).toISOString().slice(0, 10);

export const projects: Project[] = [
  { id: 'PRJ-001', code: 'NORTHSTAR-S1', title: 'Northstar / 北境回声', season: 1, status: 'post', currency: 'CNY', budgetVersionId: 'BUD-001-V3', deliveryDate: iso(44) },
  { id: 'PRJ-002', code: 'ORBIT-DOC', title: 'Orbit / 轨道之外', season: 1, status: 'production', currency: 'CNY', budgetVersionId: 'BUD-002-V2', deliveryDate: iso(126) }
];
export const budgetLines: BudgetLine[] = [
  { id: 'BL-101', projectId: 'PRJ-001', category: '制作', subcategory: '主演与主创', planned: 12800000, committed: 11200000, actual: 10400000, forecast: 13100000, owner: '制片部', risk: 'medium' },
  { id: 'BL-102', projectId: 'PRJ-001', category: '制作', subcategory: '摄影器材与场地', planned: 6800000, committed: 6400000, actual: 5980000, forecast: 7020000, owner: '现场制片', risk: 'low' },
  { id: 'BL-103', projectId: 'PRJ-001', category: '后期', subcategory: '调色、DIT、母版', planned: 5400000, committed: 4300000, actual: 2800000, forecast: 5750000, owner: '后期制片', risk: 'high' },
  { id: 'BL-104', projectId: 'PRJ-001', category: '宣发', subcategory: '预告片与物料', planned: 3600000, committed: 1900000, actual: 1240000, forecast: 3200000, owner: '营销部', risk: 'medium' },
  { id: 'BL-201', projectId: 'PRJ-002', category: '制作', subcategory: '跨国拍摄', planned: 9200000, committed: 5100000, actual: 3300000, forecast: 9000000, owner: '制片部', risk: 'medium' }
];
export const contracts: Contract[] = [
  { id: 'CTR-01', projectId: 'PRJ-001', vendor: '曜石后期制作', scope: '4K HDR 调色、声音、DCP 母版', ceiling: 5200000, committed: 4300000, paid: 2300000, milestones: [{ name: '锁剪交付', due: iso(8), amount: 1200000, status: 'invoiced' }, { name: '母版验收', due: iso(36), amount: 2000000, status: 'open' }] },
  { id: 'CTR-02', projectId: 'PRJ-001', vendor: '远景国际版权', scope: '北美与欧洲音乐同步许可', ceiling: 880000, committed: 880000, paid: 440000, milestones: [{ name: '签署', due: iso(-16), amount: 440000, status: 'paid' }, { name: '交付版权证明', due: iso(4), amount: 440000, status: 'invoiced' }] },
  { id: 'CTR-03', projectId: 'PRJ-002', vendor: '云帧视觉', scope: '纪录片航拍与卫星素材', ceiling: 1600000, committed: 1100000, paid: 600000, milestones: [{ name: '素材包一', due: iso(20), amount: 500000, status: 'open' }] }
];
export const assets: Asset[] = [
  { id: 'AST-001', projectId: 'PRJ-001', name: '北境回声 S01E01 4K HDR Master', type: 'master', version: 7, status: 'review', owner: '后期制片', checksum: 'sha256:91b7…e2a1', territories: ['CN', 'HK', 'SG'], platforms: ['影院', 'StreamBox'], availableFrom: iso(-2), availableTo: iso(730), rightsTags: ['音乐-同步许可', '演员-全媒介'] },
  { id: 'AST-002', projectId: 'PRJ-001', name: '主预告 90s / Cut A', type: 'trailer', version: 4, status: 'approved', owner: '营销部', checksum: 'sha256:42ca…9b02', territories: ['CN'], platforms: ['StreamBox', '短视频'], availableFrom: iso(6), availableTo: iso(180), rightsTags: ['演员-宣传许可'] },
  { id: 'AST-003', projectId: 'PRJ-001', name: '片尾曲 / Winter Signal', type: 'audio', version: 2, status: 'locked', owner: '音乐版权', checksum: 'sha256:113c…78f0', territories: ['CN', 'US', 'CA'], platforms: ['影院', 'StreamBox'], availableFrom: iso(-40), availableTo: iso(52), rightsTags: ['音乐-同步许可'] },
  { id: 'AST-004', projectId: 'PRJ-002', name: 'Orbit E02 Satellite Plates', type: 'master', version: 3, status: 'review', owner: '视觉总监', checksum: 'sha256:8a10…4a9d', territories: ['全球'], platforms: ['影院', 'StreamBox'], availableFrom: iso(18), availableTo: iso(365), rightsTags: ['航拍-编辑许可'] },
  // 以下两个资产用于演示版权例外：音乐特辑（母版/片尾曲标签冲突）、海外航拍短素材（节展限窗）
  { id: 'AST-005', projectId: 'PRJ-001', name: '幕后音乐特辑 / Making-of Cut', type: 'master', version: 1, status: 'review', owner: '营销部', checksum: 'sha256:7f21…55c0', territories: ['CN', 'HK'], platforms: ['StreamBox', '短视频'], availableFrom: iso(-3), availableTo: iso(120), rightsTags: ['音乐-同步许可', '演员-全媒介'] },
  { id: 'AST-006', projectId: 'PRJ-002', name: 'Orbit Aerial Festival Cut', type: 'trailer', version: 2, status: 'review', owner: '发行部', checksum: 'sha256:30bd…88a4', territories: ['US', 'CA'], platforms: ['影院', 'StreamBox'], availableFrom: iso(-5), availableTo: iso(200), rightsTags: ['航拍-编辑许可'] }
];
export const approvals: Approval[] = [
  { id: 'APR-01', projectId: 'PRJ-001', entityType: 'budget', entityId: 'BUD-001-V3', title: '后期超支预案 V3', requestedBy: '制片主任', status: 'pending', approver: '财务负责人', createdAt: iso(-1) },
  { id: 'APR-02', projectId: 'PRJ-001', entityType: 'asset', entityId: 'AST-001', title: 'E01 最终母版锁定', requestedBy: '后期制片', status: 'pending', approver: '总制片人', createdAt: iso(-2) },
  { id: 'APR-03', projectId: 'PRJ-002', entityType: 'delivery', entityId: 'DEL-007', title: '海外节展交付包', requestedBy: '发行部', status: 'approved', approver: '法务负责人', createdAt: iso(-5), comment: '已补充航拍授权凭证' }
];
export const auditEvents: AuditEvent[] = [{ id: 'AUD-01', action: 'CREATE', entity: 'budget', entityId: 'BUD-001-V3', actor: '制片主任', at: new Date(now - 86400000).toISOString(), details: '从 V2 复制并调整后期科目' }];

export function projectSummary(projectId = projects[0].id) {
  const lines = budgetLines.filter(line => line.projectId === projectId);
  const projectContracts = contracts.filter(contract => contract.projectId === projectId);
  const projectAssets = assets.filter(asset => asset.projectId === projectId);
  const projectApprovals = approvals.filter(approval => approval.projectId === projectId);
  const planned = lines.reduce((sum, line) => sum + line.planned, 0);
  const forecast = lines.reduce((sum, line) => sum + line.forecast, 0);
  const actual = lines.reduce((sum, line) => sum + line.actual, 0);
  return { project: projects.find(project => project.id === projectId), planned, forecast, actual, variance: forecast - planned, utilization: planned ? actual / planned : 0, committed: lines.reduce((sum, line) => sum + line.committed, 0), contractExposure: projectContracts.reduce((sum, contract) => sum + contract.ceiling, 0), assetCount: projectAssets.length, pendingApprovals: projectApprovals.filter(item => item.status === 'pending').length, highRiskLines: lines.filter(line => line.risk === 'high'), lines, contracts: projectContracts, assets: projectAssets, approvals: projectApprovals };
}

export function rightsConflicts(projectId = projects[0].id) {
  // 委托给带指纹与精确重叠维度的新冲突引擎，保持旧调用方的简要视图
  return buildConflicts(assets, projectId).map(conflict => ({
    severity: conflict.severity,
    assetA: conflict.names[0],
    assetB: conflict.names[1],
    reason: conflict.reasons[0],
  }));
}

/** 资产换版：返回旧版本号；版权例外的失效联动由 RightsService.onAssetVersioned 完成 */
export function bumpAssetVersion(assetId: string, actor = '当前用户') {
  const asset = assets.find(item => item.id === assetId);
  if (!asset) return undefined;
  const oldVersion = asset.version;
  asset.version += 1;
  asset.status = 'review';
  auditEvents.unshift({ id: `AUD-${Date.now()}`, action: 'VERSION_BUMP', entity: 'asset', entityId: asset.id, actor, at: new Date().toISOString(), details: `资产 ${asset.name} 从 v${oldVersion} 换版为 v${asset.version}，旧版本版权例外不延续` });
  return { asset, oldVersion, newVersion: asset.version };
}

export function approve(id: string, status: ApprovalStatus, comment = '') {
  const item = approvals.find(approval => approval.id === id); if (!item) return undefined;
  item.status = status; item.comment = comment; auditEvents.unshift({ id: `AUD-${Date.now()}`, action: status.toUpperCase(), entity: item.entityType, entityId: item.entityId, actor: '当前审批人', at: new Date().toISOString(), details: comment || `${item.title} 已${status === 'approved' ? '通过' : '驳回'}` }); return item;
}
export function createApproval(input: Pick<Approval, 'projectId' | 'entityType' | 'entityId' | 'title' | 'requestedBy' | 'approver'>) { const item: Approval = { ...input, id: `APR-${Date.now()}`, status: 'pending', createdAt: new Date().toISOString() }; approvals.unshift(item); return item; }
export function dashboard() { return projects.map(project => projectSummary(project.id)).map(summary => ({ id: summary.project?.id, title: summary.project?.title, status: summary.project?.status, forecast: summary.forecast, variance: summary.variance, pendingApprovals: summary.pendingApprovals, rightsConflicts: rightsConflicts(summary.project?.id).length })); }
