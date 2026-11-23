import { commitFiles, getRefSha, DraftBranchChangedError, GithubApiError } from './github';
import type { BufferedOp, RequestContext } from '../editor/context';
import { clearGithubIdentity } from '../auth/github-identity';
import { updateWorkspace, type Workspace } from '../workspace/workspace';
import { isGitCommit } from '../content/published-index';
import { logger } from '../logger';

const owner = process.env.GITHUB_OWNER!;
const repo = process.env.GITHUB_REPO!;
const baseBranch = process.env.GITHUB_BRANCH || 'tina';

export type CommitIdentity = {
	userId: string;
	login: string;
	token: string;
};

export function getGithubStatus(workspace: Workspace | null) {
	return {
		fork: workspace?.forkReady || workspace?.headSha ? 'ready' as const : 'unknown' as const,
		branch: workspace?.branchChanged ? 'changed_externally' as const
			: workspace?.headSha ? 'ready' as const : 'unconfirmed' as const,
		commit: workspace?.pendingCommit ? 'pending' as const : workspace?.headSha ? 'synced' as const : 'none' as const,
	};
}

function dedupe(ops: BufferedOp[]): BufferedOp[] {
	const latest = new Map<string, BufferedOp>();
	for (const op of ops) {
		latest.set(op.path, op);
	}
	return [...latest.values()];
}

function commitMessage(ops: BufferedOp[]) {
	const paths = ops.map((op) => op.path).slice(0, 3).join(', ');
	const suffix = ops.length > 3 ? `, +${ops.length - 3} more` : '';
	return `docs: update ${paths}${suffix}`;
}

export async function commitOps(
	ops: BufferedOp[],
	workspace: Workspace,
	identity: CommitIdentity,
): Promise<{ committed: boolean; sha?: string; error?: unknown }> {
	const deduped = dedupe(ops);
	if (!deduped.length) return { committed: false };
	logger.info('github.commit.started', {
		operationCount: deduped.length,
		paths: deduped.map((op) => op.path),
	});

	const changes = deduped.map((op) =>
		op.op === 'delete'
			? { path: op.path, delete: true as const }
			: { path: op.path, content: op.content ?? '' },
	);
	const changedPaths = new Set([...(workspace.changedPaths ?? []), ...deduped.map((op) => op.path)]);

	try {
		if (!workspace.branch.startsWith('oas-draft-')) {
			throw new GithubApiError(409, 'The workspace uses a legacy branch');
		}
		let commitBase = isGitCommit(workspace.baseSha) ? workspace.baseSha : undefined;
		if (!commitBase) {
			commitBase = (await getRefSha(identity.token, owner, repo, baseBranch)) ?? undefined;
			if (!commitBase) throw new Error(`Base branch ${baseBranch} was not found`);
			workspace = await updateWorkspace(identity.userId, { baseSha: commitBase });
		}

		const result = await commitFiles({
			token: identity.token,
			owner,
			repo,
			login: identity.login,
			branch: workspace.branch,
			baseSha: commitBase,
			expectedHead: workspace.headSha,
			message: commitMessage(deduped),
			changes,
		});
		await updateWorkspace(identity.userId, {
			forkReady: true,
			branchChanged: false,
			headSha: result.sha,
			changedPaths: [...changedPaths],
			pendingCommit: false,
			pendingOps: [],
		});
		logger.info('github.commit.completed', {
			sha: result.sha,
			operationCount: deduped.length,
			changedPaths: changedPaths.size,
		});
		return { committed: true, sha: result.sha };
	} catch (error) {
		if (error instanceof GithubApiError && error.status === 401) {
			clearGithubIdentity(identity.userId);
		}
		logger.error('github.commit.failed', {
			error,
			operationCount: deduped.length,
		});
		await updateWorkspace(identity.userId, {
			changedPaths: [...changedPaths],
			pendingCommit: true,
			pendingOps: deduped,
			...(error instanceof DraftBranchChangedError ? { branchChanged: true, forkReady: true } : {}),
		});
		return { committed: false, error };
	}
}

export async function flushCommit(ctx: RequestContext, workspace: Workspace) {
	if (!ctx.userId || !ctx.login || !ctx.githubToken) {
		throw new Error('flushCommit requires user identity');
	}
	return commitOps(ctx.buffer ?? [], workspace, {
		userId: ctx.userId,
		login: ctx.login,
		token: ctx.githubToken,
	});
}
