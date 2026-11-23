import express, { type Request, type Response } from 'express';
import { createPull, listOpenPulls } from './github-api';
import { commitOps } from '../github/commit';
import { HttpError, toErrorResponse } from '../http-error';
import { getGithubIdentity, GithubAuthError, clearGithubIdentity } from '../auth/github-identity';
import { withLock } from '../workspace/lock';
import { purgeWorkspace } from '../workspace/purge';
import { syncPrState } from './pr-sync';
import { enforceRateLimit } from '../workspace/ratelimit';
import { deleteDraft } from '../content/tenant';
import { getWorkspace, updateWorkspace, INACTIVE_MS, type Workspace } from '../workspace/workspace';
import { getRequestContext } from '../editor/context';
import { logger } from '../logger';
import { assertEditRevision, EDIT_REVISION_HEADER, invalidateEditRevision } from '../editor/edit-revision';
import { getEditorStatus } from '../editor/status';

const owner = process.env.GITHUB_OWNER!;
const repo = process.env.GITHUB_REPO!;
const baseBranch = process.env.GITHUB_BRANCH || 'tina';

type Identity = {
	userId: string;
	login?: string;
	token?: string;
	githubError?: string;
};

type Options = {
	isLocal: boolean;
	clerkAuth: { isAuthorized: (req: unknown) => Promise<{ isAuthorized: boolean; errorMessage?: string }> } | null;
};

function workspaceView(workspace: Workspace | null) {
	if (!workspace) return null;
	return {
		state: workspace.state,
		login: workspace.login,
		fork: workspace.fork,
		branch: workspace.branch,
		headSha: workspace.headSha ?? null,
		prNumber: workspace.prNumber ?? null,
		prUrl: workspace.prUrl ?? null,
		changedPaths: workspace.changedPaths ?? [],
		pendingCommit: Boolean(workspace.pendingCommit),
		purging: Boolean(workspace.purging),
		updatedAt: workspace.updatedAt,
		submittedAt: workspace.submittedAt ?? null,
		mergedAt: workspace.mergedAt ?? null,
		closedAt: workspace.closedAt ?? null,
	};
}

async function authenticate(options: Options, req: Request): Promise<Identity> {
	if (options.isLocal || !options.clerkAuth) {
		throw new HttpError(400, 'local_mode', 'The review API is disabled in local mode');
	}

	const result = await options.clerkAuth.isAuthorized(req);
	if (!result.isAuthorized) {
		throw new HttpError(401, 'unauthorized', result.errorMessage ?? 'Unauthorized');
	}

	const userId = (req as Request & { session?: { user?: { id: string } } }).session?.user?.id;
	if (!userId) throw new HttpError(401, 'unauthorized', 'No Clerk user id on the request');

	try {
		const identity = await getGithubIdentity(userId);
		const context = getRequestContext();
		if (context) {
			context.userId = userId;
			context.login = identity.login;
			context.githubToken = identity.token;
		}
		return { userId, login: identity.login, token: identity.token };
	} catch (error) {
		if (error instanceof GithubAuthError) {
			const context = getRequestContext();
			if (context) context.userId = userId;
			logger.warn('tina.github_identity.unavailable', { code: error.code });
			return { userId, githubError: error.code };
		}
		const context = getRequestContext();
		if (context) context.userId = userId;
		logger.warn('tina.github_identity.lookup_failed', { error });
		return { userId, githubError: 'unknown' };
	}
}

function route(handler: (req: Request, res: Response) => Promise<void>) {
	return async (req: Request, res: Response) => {
		try {
			await handler(req, res);
		} catch (error) {
			const response = toErrorResponse(error);
			logger[response.status >= 500 ? 'error' : 'warn']('http.request.failed', {
				method: req.method,
				path: req.path,
				status: response.status,
				error,
			});
			res.status(response.status).json(response.body);
		}
	};
}

export function createTinaApi(options: Options) {
	const router = express.Router();

	router.get(
		'/api/tina/workspace',
		route(async (req, res) => {
			const identity = await authenticate(options, req);
			let current = await getWorkspace(identity.userId);
			let prCheckFailed = false;
			if (current && identity.token && current.login === identity.login &&
				(current.prNumber || current.state === 'closed' || current.state === 'merged' ||
					Date.now() - current.updatedAt.getTime() > INACTIVE_MS)) {
				try {
					current = await withLock(identity.userId, async () => {
						const workspace = await getWorkspace(identity.userId);
						if (!workspace || workspace.login !== identity.login || workspace.purging) return workspace;
						const synced = await syncPrState(workspace, identity.token!).catch((error) => {
							prCheckFailed = true;
							throw error;
						});
						const expired = !synced.prNumber && Date.now() - synced.updatedAt.getTime() > INACTIVE_MS;
						if (synced.state === 'merged' || synced.state === 'closed' || expired) {
							const result = await purgeWorkspace(synced, identity.token!, expired && !synced.prNumber ? 'expired' : undefined);
							return result === 'pending' ? await getWorkspace(identity.userId) : null;
						}
						return synced;
					}, 1_000);
				} catch (error) {
					if (!(error instanceof HttpError && error.code === 'workspace_busy')) {
						logger.warn('tina.pr.status_check_failed', { error });
					}
					current = await getWorkspace(identity.userId);
				}
			}

			res.json({
				workspace: workspaceView(current),
				github: identity.githubError ? { error: identity.githubError } : null,
				status: await getEditorStatus(identity, current, req.get(EDIT_REVISION_HEADER), prCheckFailed),
			});
		}),
	);

	router.post(
		'/api/tina/submit',
		route(async (req, res) => {
			const identity = await authenticate(options, req);
			if (identity.githubError || !identity.token || !identity.login) {
				throw new HttpError(401, 'github_reauth', 'GitHub access is missing; re-authorize');
			}

			const workspace = await withLock(identity.userId, async () => {
				await assertEditRevision(identity.userId, req.get(EDIT_REVISION_HEADER));
				let current = await getWorkspace(identity.userId);
				if (!current) throw new HttpError(409, 'no_changes', 'Save your changes before submitting');
				if (current.purging || current.state === 'merged' || current.state === 'closed') {
					throw new HttpError(409, 'stale_workspace', 'This workspace is already finished');
				}
				if (current.login !== identity.login) {
					clearGithubIdentity(identity.userId);
					throw new HttpError(409, 'login_changed', 'Your GitHub login changed; discard and start over');
				}

				if (current.prNumber) {
					current = await syncPrState(current, identity.token!);
					if (current.state === 'merged' || current.state === 'closed') {
						await purgeWorkspace(current, identity.token!);
						throw new HttpError(409, 'stale_workspace', 'The previous PR was closed; start over');
					}
				}

				if (current.pendingOps?.length) {
					const committed = await commitOps(current.pendingOps, current, {
						userId: identity.userId,
						login: identity.login!,
						token: identity.token!,
					});
					if (!committed.committed) {
						throw new HttpError(502, 'commit_failed', 'Pushing to GitHub failed; try again');
					}
					current = (await getWorkspace(identity.userId)) ?? current;
				}

				const open = await listOpenPulls(
					identity.token!,
					owner,
					repo,
					identity.login!,
					current.branch,
				);
				if (open.length > 0) {
					return updateWorkspace(identity.userId, {
						state: 'submitted',
						prNumber: open[0].number,
						prUrl: open[0].html_url,
						submittedAt: current.submittedAt ?? new Date(),
					});
				}

				if (!current.changedPaths.length) {
					throw new HttpError(409, 'no_changes', 'There is nothing to submit; save your changes first');
				}

				await enforceRateLimit(identity.userId, 'pr:day');
				const files = current.changedPaths.map((path) => `- \`${path}\``).join('\n');
				const pull = await createPull({
					token: identity.token!,
					owner,
					repo,
					login: identity.login!,
					branch: current.branch,
					base: baseBranch,
					title: `docs(${identity.login}): submit for review`,
					body: `Submitted by @${identity.login} via /admin.\n\nChanged files:\n${files}`,
				});

				return updateWorkspace(identity.userId, {
					state: 'submitted',
					prNumber: pull.number,
					prUrl: pull.html_url,
					submittedAt: new Date(),
				});
			}, 2_000);

			logger.info('tina.submit.completed', {
				state: workspace.state,
				prNumber: workspace.prNumber,
				changedPaths: workspace.changedPaths.length,
			});
			res.json({ workspace: workspaceView(workspace) });
		}),
	);

	router.post(
		'/api/tina/discard',
		route(async (req, res) => {
			const identity = await authenticate(options, req);
			const result = await withLock(identity.userId, async () => {
				const workspace = await getWorkspace(identity.userId);
				if (!workspace) {
					await deleteDraft(identity.userId);
					return 'done';
				}
				await assertEditRevision(identity.userId, req.get(EDIT_REVISION_HEADER));
				if (identity.login && workspace.login !== identity.login) {
					throw new HttpError(409, 'login_changed', '请重新连接创建此草稿的 GitHub 账号。');
				}
				if (!identity.token) {
					await updateWorkspace(identity.userId, {
						purging: true,
						state: 'closed',
						closedAt: new Date(),
						endReason: workspace.endReason ?? (workspace.state === 'merged' || workspace.state === 'closed'
							? workspace.state : 'discarded'),
					});
					await invalidateEditRevision(identity.userId);
					await deleteDraft(identity.userId);
					return 'pending';
				}
				return purgeWorkspace(workspace, identity.token);
			}, 2_000);

			logger.info('tina.discard.completed', { pending: result === 'pending' });
			res.json({ discarded: true, pending: result === 'pending' });
		}),
	);

	return router;
}
