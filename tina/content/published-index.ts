import { appDb } from '../mongo';

type PublishedIndex = { _id: 'published'; namespace: string; sha?: string };

function indexes() {
	return appDb().collection<PublishedIndex>('siteState');
}

export async function getPublishedIndex() {
	const current = await indexes().findOne({ _id: 'published' });
	return current ?? { namespace: 'main', sha: undefined };
}

export async function activatePublishedIndex(namespace: string, sha?: string) {
	const update: Record<string, unknown> = {
		$set: { namespace, ...(sha ? { sha } : {}) },
	};
	if (!sha) update.$unset = { sha: '' };
	await indexes().updateOne({ _id: 'published' }, update, { upsert: true });
}

export function isGitCommit(value?: string | null) {
	return Boolean(value && /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(value));
}
