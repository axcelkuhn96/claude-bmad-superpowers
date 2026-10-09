import { createHash } from 'node:crypto';

export function targetVersion(item) {
  if (!item?.sdkId || !item?.externalId || !item?.projectId || !item?.metadata) return null;
  return createHash('sha256').update(JSON.stringify([item.sdkId, item.externalId,
    item.projectId, item.text, item.metadata])).digest('hex');
}

export function targetEligible(target, candidate) {
  return target?.status === 'active' && target.projectId === candidate.project_id &&
    target.metadata?.scope === candidate.scope &&
    (candidate.scope !== 'personal' || target.metadata?.owner_id === candidate.owner_id) &&
    !!targetVersion(target);
}
