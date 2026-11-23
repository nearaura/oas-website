import { randomUUID } from 'node:crypto';
import { getRefSha } from '../github/github';
import { HttpError } from '../http-error';
import type { RequestContext } from '../editor/context';
import { cloneDraft } from '../content/tenant';
import { clearGithubIdentity } from '../auth/github-identity';
import { syncPrState } from '../pull-request/pr-sync';
import { createWorkspace, getWorkspace, touchWorkspace, INACTIVE_MS, type Workspace } from './workspace';
import { purgeWorkspace } from './purge';
import { logger } from '../logger';
import { staleEditor } from '../editor/edit-revision';
import { getPublishedIndex, isGitCommit } from '../content/published-index';

const owner = process.env.GITHUB_OWNER!;
const repo = process.env.GITHUB_REPO!;
const baseBranch = process.env.GITHUB_BRANCH || 'tina';

function draftBranchName() {
	const timestamp = new Date()
		.toISOString()
		.replace(/[-:]/g, '')
		.replace(/\.\d{3}Z$/, 'Z');
	return `oas-draft-${timestamp}-${randomUUID().slice(0, 8)}`;
}

async function newWorkspace(ctx: RequestContext, baseSha?: string): Promise<Workspace> {
	// A non-commit marker (for example the old "startup" placeholder) cannot be
	// used as a Git parent. Fall back to the current base branch head.
	if (!isGitCommit(baseSha)) baseSha = undefined;
	try {
		baseSha ??= (await getRefSha(ctx.githubToken!, owner, repo, baseBranch)) ?? undefined;
	} catch (error) {
		// GitHub may be down; the save still writes the draft and the commit is
		// retried later once the base commit can be resolved.
		logger.warn('github.base_branch_lookup_failed', { error, branch: baseBranch });
	}
	return createWorkspace({
		userId: ctx.userId!,
		login: ctx.login!,
		fork: `${ctx.login}/${repo}`,
		branch: draftBranchName(),
		baseBranch,
		baseSha,
	});
}

export async function prepareWrite(ctx: RequestContext, published?: Awaited<ReturnType<typeof getPublishedIndex>>): Promise<Workspace> {
	if (!ctx.userId) {
		throw new HttpError(401, 'unauthorized', 'Missing Clerk user');
	}
	if (!ctx.login || !ctx.githubToken) {
		throw new HttpError(401, 'github_reauth', 'GitHub access is missing or expired; re-authorize');
	}
	published ??= await getPublishedIndex();

	let workspace = await getWorkspace(ctx.userId);

	if (workspace && workspace.login !== ctx.login) {
		clearGithubIdentity(ctx.userId);
		throw new HttpError(409, 'login_changed', '请重新连接创建此草稿的 GitHub 账号。');
	}

	if (workspace?.prNumber && !workspace.purging) {
		try {
			workspace = await syncPrState(workspace, ctx.githubToken);
		} catch (error) {
			logger.warn('tina.pr.save_time_sync_failed', { error });
			throw new HttpError(502, 'pr_status_unavailable', '暂时无法确认 PR 状态，请稍后重试保存。');
		}
	}

	if (
		workspace &&
		(workspace.purging || workspace.state === 'merged' || workspace.state === 'closed')
	) {
		const purged = await purgeWorkspace(workspace, ctx.githubToken);
		if (purged === 'pending') {
			throw new HttpError(409, 'purging', 'The previous workspace is still being cleaned up');
		}
		throw staleEditor();
	}

	if (!workspace) {
		workspace = await newWorkspace(ctx, published.sha);
	}

	// Expire idle drafts lazily even if the periodic sweep has not run yet.
	if (!workspace.prNumber && Date.now() - workspace.updatedAt.getTime() > INACTIVE_MS) {
		const purged = await purgeWorkspace(workspace, ctx.githubToken, 'expired');
		if (purged === 'pending') {
			throw new HttpError(409, 'purging', 'The expired workspace is still being cleaned up');
		}
		throw staleEditor();
	}
	if (!workspace.branch.startsWith('oas-draft-')) {
		throw new HttpError(409, 'legacy_branch', '此草稿使用旧版分支。请先完成已有 PR，或在 GitHub 保留改动后使用 Clean 开始新草稿。');
	}

	await cloneDraft(ctx.userId, published.namespace);
	ctx.namespace = `draft:${ctx.userId}`;
	if (workspace.pendingOps?.length) {
		// Retry commits that failed on the previous save, then apply this save on top.
		ctx.buffer = [...workspace.pendingOps];
	}

	await touchWorkspace(ctx.userId);
	return workspace;
}
