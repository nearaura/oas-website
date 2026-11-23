import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createDatabase, FilesystemBridge } from '@tinacms/datalayer';
import mongodbLevel from 'mongodb-level';
import { BufferingGitProvider } from '../github/git-provider';
import { activatePublishedIndex, getPublishedIndex, isGitCommit } from './published-index';
import { COLLECTION, DB_NAME, deleteNamespace, hasNamespace } from './tenant';

const { MongodbLevel } = mongodbLevel as typeof import('mongodb-level');

/**
 * A fresh self-hosted install has an empty MongoDB: no `siteState`, no
 * published namespace. In that case the admin cannot build its schema and
 * every GraphQL request fails. Build the index from the docs shipped in the
 * runtime image and activate it before the server starts listening.
 *
 * An existing index is left untouched. Rebuilding on every restart would
 * overwrite content published through the admin after the image was built.
 */
export async function ensurePublishedIndex() {
	const current = await getPublishedIndex();
	if (current.namespace && await hasNamespace(current.namespace)) {
		// Older startup indexes stored the placeholder "startup" as the base
		// commit. It is not a Git object and would make every save fail.
		if (current.sha && !isGitCommit(current.sha)) {
			await activatePublishedIndex(current.namespace);
		}
		return { namespace: current.namespace, created: false };
	}

	const { schema, graphql, lookup } = JSON.parse(
		await readFile('tina/tina-lock.json', 'utf8'),
	);
	const adapter = new MongodbLevel({
		collectionName: COLLECTION,
		dbName: DB_NAME,
		mongoUri: process.env.MONGODB_URI,
	});
	const namespace = `published:${randomUUID()}`;
	const index = createDatabase({
		databaseAdapter: adapter as unknown as Parameters<typeof createDatabase>[0]['databaseAdapter'],
		gitProvider: new BufferingGitProvider(),
		bridge: new FilesystemBridge(process.cwd()),
		namespace,
	});

	try {
		try {
			const tinaSchema = { schema } as Parameters<typeof index.indexContent>[0]['tinaSchema'];
			const result = await index.indexContent({
				graphQLSchema: graphql,
				tinaSchema,
				lookup,
			});
			if (result?.warnings?.length) throw new Error(result.warnings.join('\n'));
			if (!await hasNamespace(namespace)) throw new Error('The startup index is empty');
		} catch (error) {
			await deleteNamespace(namespace);
			throw error;
		}

		await activatePublishedIndex(
			namespace,
			isGitCommit(process.env.GIT_COMMIT) ? process.env.GIT_COMMIT : undefined,
		);
		return { namespace, created: true };
	} finally {
		await adapter.close();
	}
}