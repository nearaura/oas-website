import { randomUUID } from 'node:crypto';
import { appDb } from '../mongo';
import { HttpError } from '../http-error';

const COLLECTION = 'locks';
// Fork creation can poll GitHub for a while; keep the lock longer than the
// slowest first-save path so two saves cannot overlap.
const TTL_MS = 5 * 60 * 1000;
const RETRY_MS = 150;

type LockDoc = { _id: string; owner: string; expiresAt: Date };

let indexesReady: Promise<void> | null = null;

function collection() {
	return appDb().collection<LockDoc>(COLLECTION);
}

function ensureIndexes() {
	indexesReady ??= collection()
		.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 })
		.then(() => undefined);
	return indexesReady;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function acquireLock(userId: string, waitMs = 0): Promise<string> {
	await ensureIndexes();
	const owner = randomUUID();
	const deadline = Date.now() + waitMs;

	for (;;) {
		const now = new Date();
		const doc: LockDoc = { _id: userId, owner, expiresAt: new Date(now.getTime() + TTL_MS) };

		try {
			await collection().insertOne(doc);
			return owner;
		} catch (error) {
			if ((error as { code?: number }).code !== 11000) throw error;
		}

		// The existing lock may already be expired; drop it and try once more.
		await collection().deleteOne({ _id: userId, expiresAt: { $lt: now } });
		try {
			await collection().insertOne(doc);
			return owner;
		} catch (error) {
			if ((error as { code?: number }).code !== 11000) throw error;
			if (Date.now() >= deadline) {
				throw new HttpError(409, 'workspace_busy', 'Another save, submit, or cleanup is already running');
			}
			await sleep(RETRY_MS);
		}
	}
}

/**
 * Background work must never make a user's save fail just because the sweep
 * happened to hold the lock first.
 */
export async function tryAcquireLock(userId: string): Promise<string | null> {
	try {
		return await acquireLock(userId);
	} catch (error) {
		if (error instanceof HttpError && error.code === 'workspace_busy') return null;
		throw error;
	}
}

export async function releaseLock(userId: string, owner: string) {
	await collection().deleteOne({ _id: userId, owner });
}

export async function withLock<T>(userId: string, fn: () => Promise<T>, waitMs = 0): Promise<T> {
	const owner = await acquireLock(userId, waitMs);
	try {
		return await fn();
	} finally {
		await releaseLock(userId, owner);
	}
}