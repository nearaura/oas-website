import { commitOps } from '../github/commit';
import { getGithubIdentity } from '../auth/github-identity';
import { tryAcquireLock, releaseLock } from './lock';
import { purgeWorkspace } from './purge';
import { syncPrState } from '../pull-request/pr-sync';
import { findWorkspaces, getWorkspace, INACTIVE_MS } from './workspace';
import { logger } from '../logger';

const SWEEP_MS = 10 * 60 * 1000;

let running = false;

async function tokenFor(userId: string) {
	try {
		return await getGithubIdentity(userId);
	} catch (error) {
		logger.warn('sweep.github_token_unavailable', { error, userId });
		return null;
	}
}

export async function sweepWorkspace(userId: string, now: Date, resolveIdentity = tokenFor) {
	const owner = await tryAcquireLock(userId);
	if (!owner) return;
	try {
		let workspace = await getWorkspace(userId);
		if (!workspace) return;
		const expired = !workspace.prNumber && workspace.updatedAt.getTime() < now.getTime() - INACTIVE_MS;
		const terminal = workspace.state === 'merged' || workspace.state === 'closed';
		if (!workspace.purging && !workspace.pendingCommit && !workspace.prNumber && !terminal && !expired) return;

		const identity = await resolveIdentity(userId);
		if (!identity || identity.login !== workspace.login) return;
		const { token } = identity;
		if (workspace.prNumber && !workspace.purging) {
			workspace = await syncPrState(workspace, token);
		}
		if (workspace.purging || workspace.state === 'merged' || workspace.state === 'closed') {
			await purgeWorkspace(workspace, token);
			return;
		}
		if (workspace.pendingCommit) {
			await commitOps(workspace.pendingOps ?? [], workspace, { userId, login: identity.login, token });
			return;
		}
		if (expired) await purgeWorkspace(workspace, token, 'expired');
	} finally {
		await releaseLock(userId, owner);
	}
}

export async function runSweep(now = new Date()): Promise<void> {
	if (running) return;
	running = true;

	try {
		logger.info('sweep.started', { at: now.toISOString() });
		const workspaces = await findWorkspaces(
			{
				$or: [
					{ purging: true },
					{ pendingCommit: true },
					{ state: { $in: ['merged', 'closed'] } },
					{ state: 'submitted' },
					{ updatedAt: { $lt: new Date(now.getTime() - INACTIVE_MS) } },
				],
			},
			100,
		);

		for (const { _id } of workspaces) {
			try {
				await sweepWorkspace(_id, now);
			} catch (error) {
				logger.error('sweep.workspace_failed', { error, workspaceId: _id });
			}
		}
		logger.info('sweep.completed', { workspaceCount: workspaces.length });
	} finally {
		running = false;
	}
}

export function startSweep() {
	const run = () => void runSweep().catch((error) => logger.error('sweep.failed', { error }));
	const interval = setInterval(run, SWEEP_MS);
	interval.unref?.();
	const first = setTimeout(run, 30_000);
	first.unref?.();
}
