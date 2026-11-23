interface Env {
	ASSETS: { fetch: (request: Request) => Promise<Response> };
	BACKEND_ORIGIN?: string;
}

const PROXY_PREFIXES = ['/api/tina/', '/tina-island/'];

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);

		if (!PROXY_PREFIXES.some((prefix) => url.pathname.startsWith(prefix))) {
			return env.ASSETS.fetch(request);
		}

		if (!env.BACKEND_ORIGIN) {
			return new Response('BACKEND_ORIGIN is not configured for this Worker', { status: 500 });
		}

		let upstream: URL;
		try {
			upstream = new URL(url.pathname + url.search, env.BACKEND_ORIGIN);
		} catch {
			return new Response(`BACKEND_ORIGIN is not a valid URL: ${env.BACKEND_ORIGIN}`, { status: 500 });
		}

		const headers = new Headers(request.headers);
		headers.delete('host');
		for (const header of ['connection', 'keep-alive', 'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade']) {
			headers.delete(header);
		}
		const hasBody = request.method !== 'GET' && request.method !== 'HEAD' && request.headers.get('content-length') !== '0';
		if (!hasBody) headers.delete('content-length');
		const isIsland = url.pathname.startsWith('/tina-island/');
		if (isIsland) headers.set('accept-encoding', 'identity');

		try {
			const response = await fetch(upstream, {
				method: request.method,
				headers,
				body: hasBody ? request.body : undefined,
				redirect: 'manual',
			});
			const responseHeaders = new Headers(response.headers);
			for (const header of ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']) {
				responseHeaders.delete(header);
			}
			if (isIsland) {
				return new Response(await response.text(), {
					status: response.status,
					statusText: response.statusText,
					headers: {
						'cache-control': 'no-store',
						'content-type': response.headers.get('content-type') ?? 'text/html; charset=utf-8',
					},
				});
			}
			return new Response(await response.arrayBuffer(), {
				status: response.status,
				statusText: response.statusText,
				headers: responseHeaders,
			});
		} catch (error) {
			return new Response(`Backend unreachable: ${error instanceof Error ? error.message : String(error)}`, { status: 502 });
		}
	},
};
